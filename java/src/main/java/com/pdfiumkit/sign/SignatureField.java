package com.pdfiumkit.sign;

import com.pdfiumkit.PdfError;
import com.pdfiumkit.writer.PdfAppend;
import com.pdfiumkit.writer.PdfObjects;
import com.pdfiumkit.writer.PdfTrailer;
import com.pdfiumkit.writer.PdfValue;
import java.nio.charset.StandardCharsets;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Placing a signature field in a document.
 *
 * Everything except the cryptography. The field, its signature dictionary and the
 * AcroForm entry are appended as an incremental update, with a fixed-size /Contents
 * placeholder that the signer patches in place afterwards.
 *
 * The placeholder's size is fixed because /ByteRange records absolute offsets: writing
 * the signature by re-serialising would shift every offset after it, and the range would
 * then name the wrong bytes.
 */
final class SignatureField {

  /** Every offset is written this wide so patching cannot move a single byte. */
  private static final int OFFSET_WIDTH = 10;

  record Placement(byte[] bytes, int contentsAt, int contentsLength, List<Integer> byteRange) {}

  private SignatureField() {}

  static Placement place(byte[] base, PdfSignOptions options) {
    if (options.reservedBytes() < 64) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION,
          "sign: reservedBytes is far too small for any signature");
    }

    // Scanning the trailer refuses encrypted documents, which is right here too: the
    // strings about to be written would have to be encrypted with the document key.
    PdfTrailer trailer = PdfTrailer.scan(base);
    PdfObjects objects = new PdfObjects(base);
    int catalogNumber = objects.catalogNumber(trailer);
    String catalog = objects.inner(catalogNumber);

    int first = trailer.nextObjectNumber();
    int signatureNumber = first;
    int widgetNumber = first + 1;

    List<Integer> pages = objects.pages(catalogNumber);
    if (options.pageIndex() < 0 || options.pageIndex() >= pages.size()) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION,
          "sign: the document has no page " + options.pageIndex());
    }
    int pageNumber = pages.get(options.pageIndex());

    Map<Integer, PdfValue> out = new LinkedHashMap<>();

    StringBuilder signature = new StringBuilder("<< /Type /Sig /Filter /Adobe.PPKLite")
        .append(" /SubFilter /").append(options.subFilter())
        .append(" /ByteRange [").append(pad(0)).append(' ').append(pad(0)).append(' ')
        .append(pad(0)).append(' ').append(pad(0)).append(']')
        .append(" /Contents <").append("0".repeat(options.reservedBytes() * 2)).append('>')
        .append(" /M (").append(pdfDate()).append(')');
    if (options.reason() != null) signature.append(" /Reason (").append(escape(options.reason())).append(')');
    if (options.contactInfo() != null) {
      signature.append(" /ContactInfo (").append(escape(options.contactInfo())).append(')');
    }
    out.put(signatureNumber, raw(signature.append(" >>").toString()));

    String fieldName = options.fieldName() != null ? options.fieldName()
        : "Signature" + (System.currentTimeMillis() % 100000);
    // An invisible signature: zero rect, hidden and not printed. Valid without an
    // appearance stream, which is why the first release does not draw one.
    out.put(widgetNumber, raw("<< /Type /Annot /Subtype /Widget /FT /Sig /T ("
        + escape(fieldName) + ") /V " + signatureNumber + " 0 R /Rect [0 0 0 0] /F 132 /P "
        + pageNumber + " 0 R >>"));

    // Merge rather than replace: an existing AcroForm carries /DR, /DA and the
    // document's other fields, and dropping them would break every form in the file.
    String acroValue = PdfObjects.entryOf(catalog, "AcroForm");
    Integer acroNumber = referenceIn(acroValue);
    String acroInner = acroNumber != null ? objects.inner(acroNumber)
        : acroValue != null && acroValue.startsWith("<<") ? strip(acroValue, "<<", ">>") : "";

    String existingFields = PdfObjects.entryOf(acroInner, "Fields");
    String fields = existingFields == null ? "" : strip(existingFields, "[", "]");
    int acroFormNumber = acroNumber != null ? acroNumber : first + 2;
    out.put(acroFormNumber, PdfObjects.mergeInto(acroInner,
        "/Fields [" + join(fields, widgetNumber + " 0 R") + "] /SigFlags 3"));

    if (acroNumber == null) {
      out.put(catalogNumber, objects.merged(catalogNumber, "/AcroForm " + acroFormNumber + " 0 R"));
    }

    String page = objects.inner(pageNumber);
    String annotsValue = PdfObjects.entryOf(page, "Annots");
    Integer annotsNumber = referenceIn(annotsValue);
    String annots = annotsNumber != null ? strip(objects.body(annotsNumber).trim(), "[", "]")
        : annotsValue != null && annotsValue.startsWith("[") ? strip(annotsValue, "[", "]") : "";
    out.put(pageNumber, PdfObjects.mergeInto(page,
        "/Annots [" + join(annots, widgetNumber + " 0 R") + "]"));

    return patchByteRange(PdfAppend.append(base, out, null), options.reservedBytes());
  }

  /**
   * Rewrites the /ByteRange placeholder with the real offsets. Both the placeholder and
   * the values are {@link #OFFSET_WIDTH} digits wide, so nothing moves.
   */
  private static Placement patchByteRange(byte[] bytes, int reservedBytes) {
    String text = new String(bytes, StandardCharsets.ISO_8859_1);
    int contentsMarker = text.lastIndexOf("/Contents <");
    if (contentsMarker < 0) throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: the placeholder went missing");
    int rangeMarker = text.lastIndexOf("/ByteRange [");
    if (rangeMarker < 0) throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: the byte range went missing");

    int contentsAt = contentsMarker + "/Contents ".length();
    int contentsLength = reservedBytes * 2 + 2;
    List<Integer> byteRange = List.of(0, contentsAt, contentsAt + contentsLength,
        bytes.length - (contentsAt + contentsLength));

    StringBuilder written = new StringBuilder("[");
    for (int value : byteRange) written.append(written.length() == 1 ? "" : " ").append(pad(value));
    byte[] encoded = written.append(']').toString().getBytes(StandardCharsets.ISO_8859_1);

    byte[] out = bytes.clone();
    System.arraycopy(encoded, 0, out, rangeMarker + "/ByteRange ".length(), encoded.length);
    return new Placement(out, contentsAt, contentsLength, byteRange);
  }

  private static String pad(int value) {
    String digits = String.valueOf(value);
    return "0".repeat(Math.max(0, OFFSET_WIDTH - digits.length())) + digits;
  }

  /** `D:YYYYMMDDHHmmSS+00'00'`, the form the reader already parses. */
  private static String pdfDate() {
    ZonedDateTime now = ZonedDateTime.now(ZoneOffset.UTC);
    return String.format("D:%04d%02d%02d%02d%02d%02d+00'00'", now.getYear(), now.getMonthValue(),
        now.getDayOfMonth(), now.getHour(), now.getMinute(), now.getSecond());
  }

  /** The object number when the value is `N G R`, else null: both forms appear in real files. */
  private static Integer referenceIn(String value) {
    if (value == null) return null;
    Matcher m = Pattern.compile("^(\\d+)\\s+\\d+\\s+R$").matcher(value);
    return m.matches() ? Integer.valueOf(m.group(1)) : null;
  }

  private static String strip(String value, String open, String close) {
    String trimmed = value.trim();
    if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) return trimmed;
    return trimmed.substring(open.length(), trimmed.length() - close.length()).trim();
  }

  private static String join(String existing, String added) {
    return existing.isEmpty() ? added : existing + " " + added;
  }

  private static String escape(String value) {
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)");
  }

  private static PdfValue raw(String dictionary) {
    return new PdfValue.Raw(PdfValue.ascii(dictionary));
  }
}
