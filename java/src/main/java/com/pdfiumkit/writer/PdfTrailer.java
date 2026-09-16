package com.pdfiumkit.writer;

import com.pdfiumkit.PdfError;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** What the end of a PDF says about itself: where the last xref is, and what it points to. */
public record PdfTrailer(long startXref, Style style, int size, int highestObject,
                         String root, String info, String id) {
  public enum Style { TABLE, STREAM }

  /**
   * Where the next appended object should be numbered.
   *
   * Not simply /Size: real files disagree with their own trailer. PDFium's own
   * bug_455199.pdf declares /Size 6 while its table lists objects 0 to 6, so trusting
   * /Size would overwrite a live object — in that file, the page's content stream.
   */
  public int nextObjectNumber() {
    return Math.max(size, highestObject + 1);
  }

  public static PdfTrailer scan(byte[] bytes) {
    String text = new String(bytes, StandardCharsets.ISO_8859_1);

    int at = text.lastIndexOf("startxref");
    if (at < 0) throw new PdfError(PdfError.Code.INVALID_OPERATION, "the file has no startxref");
    Matcher offset = Pattern.compile("startxref\\s+(\\d+)").matcher(text);
    long startXref = -1;
    while (offset.find(at)) { startXref = Long.parseLong(offset.group(1)); break; }
    if (startXref < 0) throw new PdfError(PdfError.Code.INVALID_OPERATION, "startxref has no offset");

    // The trailer dictionary is either after the keyword, or the xref stream's own.
    int trailerAt = text.lastIndexOf("trailer");
    String dictionary;
    Style style;
    if (trailerAt >= 0 && trailerAt > text.lastIndexOf("/Type /XRef")) {
      dictionary = dictionaryAt(text, trailerAt);
      style = Style.TABLE;
    } else {
      int streamAt = (int) Math.min(startXref, text.length() - 1);
      dictionary = dictionaryAt(text, streamAt);
      style = Style.STREAM;
    }

    if (dictionary.contains("/Encrypt")) {
      // Strings in appended objects would have to be encrypted with the document's key.
      // Writing them in the clear gives a file that opens and shows mojibake, which is
      // worse than refusing.
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "cannot append to an encrypted document");
    }

    return new PdfTrailer(startXref, style,
        intEntry(dictionary, "Size", 0),
        highestObjectNumber(text, intEntry(dictionary, "Size", 0)),
        refEntry(dictionary, "Root"), refEntry(dictionary, "Info"), arrayEntry(dictionary, "ID"));
  }

  private static String dictionaryAt(String text, int from) {
    int open = text.indexOf("<<", from);
    if (open < 0) return "";
    int depth = 0;
    for (int i = open; i < text.length() - 1; i++) {
      if (text.charAt(i) == '<' && text.charAt(i + 1) == '<') { depth++; i++; }
      else if (text.charAt(i) == '>' && text.charAt(i + 1) == '>') {
        depth--; i++;
        if (depth == 0) return text.substring(open, i + 1);
      }
    }
    return text.substring(open);
  }

  private static int intEntry(String dictionary, String key, int fallback) {
    Matcher m = Pattern.compile("/" + key + "\\s+(\\d+)").matcher(dictionary);
    return m.find() ? Integer.parseInt(m.group(1)) : fallback;
  }

  private static String refEntry(String dictionary, String key) {
    Matcher m = Pattern.compile("/" + key + "\\s+(\\d+\\s+\\d+\\s+R)").matcher(dictionary);
    return m.find() ? m.group(1) : null;
  }

  private static String arrayEntry(String dictionary, String key) {
    Matcher m = Pattern.compile("/" + key + "\\s*(\\[[^\\]]*\\])").matcher(dictionary);
    return m.find() ? m.group(1) : null;
  }

  /**
   * Scans for {@code N G obj} headers, the only account of object numbers that cannot
   * disagree with itself. Objects inside object streams are invisible here, which is why
   * /Size still participates in the maximum.
   */
  private static int highestObjectNumber(String text, int size) {
    int highest = size - 1;
    Matcher header = Pattern.compile("(?:^|[\\s>])(\\d+)\\s+(\\d+)\\s+obj\\b").matcher(text);
    while (header.find()) {
      int n = plausible(header.group(1));
      if (n > highest) highest = n;
    }
    Matcher subsection = Pattern.compile("\\bxref\\s*\\n\\s*(\\d+)\\s+(\\d+)").matcher(text);
    while (subsection.find()) {
      int first = plausible(subsection.group(1));
      int count = plausible(subsection.group(2));
      if (first >= 0 && count >= 0 && first + count - 1 > highest) highest = first + count - 1;
    }
    return highest;
  }

  /**
   * The scan runs over the whole file, binary stream data included, so it finds byte
   * sequences that merely look like object headers. The spec caps object numbers at
   * 8,388,607; anything above is a false match, not a ten-million-object document.
   */
  private static int plausible(String digits) {
    if (digits.length() > 8) return -1;
    long value = Long.parseLong(digits);
    return value <= 8_388_607 ? (int) value : -1;
  }
}
