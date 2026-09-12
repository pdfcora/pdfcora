import Foundation
import CPdfium

/// How to write the document out.
public enum PdfSaveMode: Sendable {
    /// Rewrite the whole file. The default, and the only mode that reliably persists
    /// newly created annotations.
    case full
    /// Append changes, preserving the original bytes and any existing signatures.
    ///
    /// - Important: verified against PDFium `chromium/7243`, annotations created in this
    ///   session are **not** written in this mode — only edits to objects that already
    ///   existed, such as form field values. Use ``full`` after adding annotations.
    case incremental
}

/// Collects the bytes PDFium hands back during a save.
private final class SaveBuffer {
    var data = Data()
}

/// `base` must be the first member: PDFium hands the callback an `FPDF_FILEWRITE*`,
/// which we cast back to this struct.
private struct SaveContext {
    var base: FPDF_FILEWRITE
    var buffer: UnsafeMutableRawPointer
}

private let writeBlock: @convention(c) (UnsafeMutablePointer<FPDF_FILEWRITE>?, UnsafeRawPointer?, UInt) -> Int32 = { fileWrite, bytes, size in
    guard let fileWrite, let bytes else { return 0 }
    let context = UnsafeRawPointer(fileWrite).assumingMemoryBound(to: SaveContext.self)
    let buffer = Unmanaged<SaveBuffer>.fromOpaque(context.pointee.buffer).takeUnretainedValue()
    buffer.data.append(bytes.assumingMemoryBound(to: UInt8.self), count: Int(size))
    return 1
}

extension PdfDocument {
    /// Serialises the document, including any edits made through this SDK.
    public func data(mode: PdfSaveMode = .full) throws -> Data {
        let handle = try requireHandle()

        // Commit any in-progress form edit before serialising, or the last field typed
        // into is silently omitted.
        if let form { FORM_ForceToKillFocus(form) }

        let buffer = SaveBuffer()
        var context = SaveContext(
            base: FPDF_FILEWRITE(version: 1, WriteBlock: writeBlock),
            buffer: Unmanaged.passUnretained(buffer).toOpaque()
        )

        let flags = FPDF_DWORD(mode == .incremental ? FPDF_INCREMENTAL : FPDF_NO_INCREMENTAL)
        let ok = withUnsafeMutablePointer(to: &context) {
            $0.withMemoryRebound(to: FPDF_FILEWRITE.self, capacity: 1) {
                FPDF_SaveAsCopy(handle, $0, flags)
            }
        }

        guard ok != 0 else { throw PdfError.saveFailed(reason: "PDFium refused to serialise the document") }
        guard !buffer.data.isEmpty else { throw PdfError.saveFailed(reason: "no bytes were produced") }
        return buffer.data
    }

    /// Writes the document to `url`.
    public func write(to url: URL, mode: PdfSaveMode = .full) throws {
        let bytes = try data(mode: mode)
        do {
            try bytes.write(to: url, options: .atomic)
        } catch {
            throw PdfError.saveFailed(reason: error.localizedDescription)
        }
    }
}
