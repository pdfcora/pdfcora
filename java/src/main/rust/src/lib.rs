//! DOCX to PDF for the Java SDK, behind a C API the JNI glue links against.

use std::ffi::CString;
use std::io::{Cursor, Read};
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};

const TOO_LARGE: &str = "the DOCX is too large";

#[derive(Clone, Copy)]
struct Limits {
    max_input: usize,
    /// The total bytes the ZIP's entries unpack to, so a small file cannot unpack to gigabytes.
    max_unpacked: u64,
}

impl Limits {
    const DEFAULT: Limits = Limits { max_input: 100 << 20, max_unpacked: 512 << 20 };
}

enum Outcome {
    Pdf(Vec<u8>),
    NotDocx,
    Failed(String),
}

fn convert(data: &[u8], limits: Limits) -> Outcome {
    if data.len() > limits.max_input {
        return Outcome::Failed(TOO_LARGE.into());
    }
    let is_zip = data.starts_with(b"PK\x03\x04");
    let mut archive = match zip::ZipArchive::new(Cursor::new(data)) {
        Ok(archive) => archive,
        Err(_) if !is_zip => return Outcome::NotDocx,
        Err(e) => return Outcome::Failed(format!("the DOCX could not be converted: {e}")),
    };
    if archive.index_for_name("word/document.xml").is_none() {
        return Outcome::NotDocx;
    }
    // Count what really comes out: a ZIP can declare small sizes and inflate far past them.
    let mut remaining = limits.max_unpacked;
    for i in 0..archive.len() {
        let read = archive.by_index(i).and_then(|entry| {
            Ok(std::io::copy(&mut entry.take(remaining + 1), &mut std::io::sink())?)
        });
        match read {
            Ok(n) if n > remaining => return Outcome::Failed(TOO_LARGE.into()),
            Ok(n) => remaining -= n,
            Err(e) => return Outcome::Failed(format!("the DOCX could not be converted: {e}")),
        }
    }
    match docxide_pdf::convert_docx_bytes_to_pdf_bytes(data) {
        Ok(pdf) => Outcome::Pdf(pdf),
        Err(e) => Outcome::Failed(format!("the DOCX could not be converted: {e}")),
    }
}

/// # Safety
/// `data` points to `len` readable bytes; `out`, `out_len` and `error` are writable.
#[no_mangle]
pub unsafe extern "C" fn pdfcora_docx_convert(
    data: *const u8,
    len: usize,
    out: *mut *mut u8,
    out_len: *mut usize,
    error: *mut *mut c_char,
) -> i32 {
    let input = std::slice::from_raw_parts(data, len);
    let outcome = catch_unwind(AssertUnwindSafe(|| convert(input, Limits::DEFAULT))).unwrap_or_else(|_| {
        Outcome::Failed("the DOCX could not be converted: internal error".into())
    });
    match outcome {
        Outcome::Pdf(pdf) => {
            *out_len = pdf.len();
            *out = Box::into_raw(pdf.into_boxed_slice()) as *mut u8;
            0
        }
        Outcome::NotDocx => 1,
        Outcome::Failed(message) => {
            let message = CString::new(message.replace('\0', " ")).unwrap_or_default();
            *error = message.into_raw();
            2
        }
    }
}

/// # Safety
/// `out` and `len` are exactly what a successful `pdfcora_docx_convert` returned.
#[no_mangle]
pub unsafe extern "C" fn pdfcora_docx_free(out: *mut u8, len: usize) {
    if !out.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(out, len)));
    }
}

/// # Safety
/// `error` is what a failed `pdfcora_docx_convert` returned.
#[no_mangle]
pub unsafe extern "C" fn pdfcora_docx_free_error(error: *mut c_char) {
    if !error.is_null() {
        drop(CString::from_raw(error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Vec<u8> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../conformance/fixtures");
        std::fs::read(root.join(name)).unwrap()
    }

    #[test]
    fn converts_hello() {
        match convert(&fixture("docx/hello.docx"), Limits::DEFAULT) {
            Outcome::Pdf(bytes) => assert!(bytes.starts_with(b"%PDF-")),
            _ => panic!("expected a PDF"),
        }
    }

    #[test]
    fn not_docx_zip_is_not_docx() {
        assert!(matches!(convert(&fixture("docx/not-docx.zip"), Limits::DEFAULT), Outcome::NotDocx));
    }

    #[test]
    fn pdf_bytes_are_not_docx() {
        assert!(matches!(convert(&fixture("contract.pdf"), Limits::DEFAULT), Outcome::NotDocx));
    }

    #[test]
    fn truncated_fails() {
        match convert(&fixture("docx/truncated.docx"), Limits::DEFAULT) {
            Outcome::Failed(message) => {
                assert!(message.starts_with("the DOCX could not be converted: "), "{message}")
            }
            _ => panic!("expected a failure"),
        }
    }

    #[test]
    fn input_over_limit_fails() {
        let limits = Limits { max_input: 10, ..Limits::DEFAULT };
        match convert(&fixture("docx/hello.docx"), limits) {
            Outcome::Failed(message) => assert_eq!(message, "the DOCX is too large"),
            _ => panic!("expected a failure"),
        }
    }

    #[test]
    fn unpacked_over_limit_fails() {
        let limits = Limits { max_unpacked: 100, ..Limits::DEFAULT };
        match convert(&fixture("docx/hello.docx"), limits) {
            Outcome::Failed(message) => assert_eq!(message, "the DOCX is too large"),
            _ => panic!("expected a failure"),
        }
    }

    /// hello.docx with a large document.xml whose declared size is patched down to 1000.
    fn lying_docx(real_size: usize) -> Vec<u8> {
        use std::io::Write;
        let padding = " ".repeat(real_size);
        let document = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{padding}<w:p/></w:body></w:document>"
        );
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("word/document.xml", options).unwrap();
        zip.write_all(document.as_bytes()).unwrap();
        let mut bytes = zip.finish().unwrap().into_inner();
        let lie = 1000u32.to_le_bytes();
        let local = 22; // uncompressed size in the local file header
        bytes[local..local + 4].copy_from_slice(&lie);
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap() + 24;
        bytes[central..central + 4].copy_from_slice(&lie);
        bytes
    }

    #[test]
    fn unpacked_limit_counts_real_bytes_not_declared_sizes() {
        let limits = Limits { max_unpacked: 100_000, ..Limits::DEFAULT };
        match convert(&lying_docx(1_000_000), limits) {
            Outcome::Failed(message) => assert_eq!(message, "the DOCX is too large"),
            _ => panic!("expected a failure"),
        }
    }

    #[test]
    fn converts_with_read_only_home() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!("pdfcora-docx-ro-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o555)).unwrap();
        std::env::set_var("HOME", &home);
        std::env::set_var("XDG_CACHE_HOME", &home);
        let outcome = convert(&fixture("docx/hello.docx"), Limits::DEFAULT);
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&home).unwrap();
        assert!(matches!(outcome, Outcome::Pdf(_)));
    }

    #[test]
    fn c_api_round_trip() {
        let input = fixture("docx/hello.docx");
        let mut out: *mut u8 = std::ptr::null_mut();
        let mut out_len = 0usize;
        let mut error: *mut std::os::raw::c_char = std::ptr::null_mut();
        let status = unsafe { pdfcora_docx_convert(input.as_ptr(), input.len(), &mut out, &mut out_len, &mut error) };
        assert_eq!(status, 0);
        assert!(out_len > 0 && error.is_null());
        unsafe { pdfcora_docx_free(out, out_len) };

        let input = fixture("docx/not-docx.zip");
        let status = unsafe { pdfcora_docx_convert(input.as_ptr(), input.len(), &mut out, &mut out_len, &mut error) };
        assert_eq!(status, 1);
        assert!(error.is_null());
    }
}
