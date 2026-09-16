package com.pdfiumkit.sign;

import com.pdfiumkit.PdfError;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Signing a document.
 *
 * The field and its fixed-size placeholder are placed first, then the signed ranges are
 * handed to the caller's CMS implementation and the result is patched into the
 * placeholder without moving a byte.
 *
 * The original bytes are never rewritten: the signature is appended as an incremental
 * update, so a signature already in the file keeps verifying.
 */
public final class PdfSigning {
  private static final byte[] HEX = "0123456789ABCDEF".getBytes(StandardCharsets.ISO_8859_1);

  private PdfSigning() {}

  /** Signs `base`, returning the signed bytes. `base` is not modified. */
  public static byte[] sign(byte[] base, PdfSignOptions options) {
    SignatureField.Placement placed = SignatureField.place(base, options);

    // The signed content is the file with the placeholder cut out — exactly what the
    // byte range names, and exactly what a verifier will re-assemble.
    byte[] cms = options.signer().sign(concatRanges(placed.bytes(), placed.byteRange()));
    if (cms == null || cms.length == 0) {
      throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: the signer returned nothing");
    }
    if (cms.length > options.reservedBytes()) {
      // Truncating would produce a file that opens and fails to verify, with no clue why.
      throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: the signature is " + cms.length
          + " bytes but only " + options.reservedBytes()
          + " were reserved; pass a larger reservedBytes");
    }
    return patchContents(placed.bytes(), placed.contentsAt(), cms);
  }

  /** Writes the signature into the placeholder as hex, leaving the rest as zeros. */
  private static byte[] patchContents(byte[] bytes, int contentsAt, byte[] cms) {
    byte[] out = bytes.clone();
    // contentsAt points at '<'; the hex begins one byte later and the space is already
    // filled with '0', so only the signature's own digits are written.
    int cursor = contentsAt + 1;
    for (byte value : cms) {
      out[cursor++] = HEX[(value & 0xff) >> 4];
      out[cursor++] = HEX[value & 0x0f];
    }
    return out;
  }

  private static byte[] concatRanges(byte[] bytes, List<Integer> byteRange) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (int i = 0; i + 1 < byteRange.size(); i += 2) {
      out.write(bytes, byteRange.get(i), byteRange.get(i + 1));
    }
    return out.toByteArray();
  }
}
