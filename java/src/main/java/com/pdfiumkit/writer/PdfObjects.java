package com.pdfiumkit.writer;

import com.pdfiumkit.PdfError;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Just enough of a PDF object reader to add entries to dictionaries that already exist.
 *
 * The writer only ever needs to *extend* two kinds of object — the catalog and each page
 * — so this finds an object's dictionary text and hands it back for a merged copy to be
 * written. It reads objects written plainly, which is what PDFium's own full save
 * produces, and tagging always runs on such a save. A document whose objects live inside
 * object streams is refused rather than half-read.
 */
public final class PdfObjects {
  private final String text;

  public PdfObjects(byte[] bytes) {
    this.text = new String(bytes, StandardCharsets.ISO_8859_1);
  }

  /** The catalog's object number, from the trailer's /Root. */
  public int catalogNumber(PdfTrailer trailer) {
    if (trailer.root() == null) throw new PdfError(PdfError.Code.INVALID_OPERATION, "no /Root in the trailer");
    return Integer.parseInt(trailer.root().split("\\s+")[0]);
  }

  /** The body of object `number`, without its header and `endobj`. */
  public String body(int number) {
    Matcher header = Pattern.compile("(?:^|[\\s>])" + number + "\\s+0\\s+obj\\b").matcher(text);
    if (!header.find()) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION,
          "object " + number + " is not written plainly; a document using object streams cannot be tagged here");
    }
    int start = header.end();
    int end = text.indexOf("endobj", start);
    return end < 0 ? text.substring(start) : text.substring(start, end);
  }

  /**
   * The object's dictionary with `additions` merged in, ready to be written back.
   *
   * Entries the caller adds replace any of the same name, so the result is the original
   * with the new keys applied rather than a dictionary built from scratch — a page keeps
   * its /Contents, /Resources and /MediaBox, which is the whole point.
   */
  public PdfValue merged(int number, String additions) {
    String body = body(number).trim();
    int open = body.indexOf("<<");
    int close = body.lastIndexOf(">>");
    if (open < 0 || close < 0) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "object " + number + " is not a dictionary");
    }
    String inner = body.substring(open + 2, close);
    for (String key : keysOf(additions)) inner = removeEntry(inner, key);
    return new PdfValue.Raw(PdfValue.ascii("<<" + inner + " " + additions + ">>"));
  }

  /** Page object numbers in document order, by walking /Pages and its /Kids. */
  public List<Integer> pages(int catalogNumber) {
    List<Integer> out = new ArrayList<>();
    Matcher pagesRef = Pattern.compile("/Pages\\s+(\\d+)\\s+\\d+\\s+R").matcher(body(catalogNumber));
    if (!pagesRef.find()) throw new PdfError(PdfError.Code.INVALID_OPERATION, "the catalog has no /Pages");
    collect(Integer.parseInt(pagesRef.group(1)), out, 0);
    return out;
  }

  private void collect(int node, List<Integer> out, int depth) {
    if (depth > 32) return;                       // a malformed tree cannot loop forever
    String body = body(node);
    // PDFium writes /Type/Page with no space, other producers write /Type /Page; both
    // are valid, so the space is optional here.
    boolean isLeaf = Pattern.compile("/Type\\s*/Page\\b").matcher(body).find()
        && !Pattern.compile("/Type\\s*/Pages\\b").matcher(body).find();
    if (isLeaf) { out.add(node); return; }

    Matcher kids = Pattern.compile("/Kids\\s*\\[([^\\]]*)\\]").matcher(body);
    if (!kids.find()) return;
    Matcher child = Pattern.compile("(\\d+)\\s+\\d+\\s+R").matcher(kids.group(1));
    while (child.find()) collect(Integer.parseInt(child.group(1)), out, depth + 1);
  }

  private static List<String> keysOf(String additions) {
    List<String> keys = new ArrayList<>();
    Matcher m = Pattern.compile("/(\\w+)\\s").matcher(additions);
    while (m.find()) { keys.add(m.group(1)); if (keys.size() > 16) break; }
    return keys;
  }

  /** Drops one `/Key value` pair, so the addition replaces rather than duplicates it. */
  private static String removeEntry(String dictionary, String key) {
    Matcher m = Pattern.compile("/" + key + "\\s*(<<|\\[|/\\w+|\\d+\\s+\\d+\\s+R|\\d+|true|false|\\([^)]*\\))")
        .matcher(dictionary);
    if (!m.find()) return dictionary;
    int start = m.start();
    int end = m.end();
    String opener = m.group(1);
    if (opener.equals("<<") || opener.equals("[")) {
      String close = opener.equals("<<") ? ">>" : "]";
      int depth = 1;
      int at = m.end();
      while (at < dictionary.length() && depth > 0) {
        if (dictionary.startsWith(opener, at)) { depth++; at += opener.length(); }
        else if (dictionary.startsWith(close, at)) { depth--; at += close.length(); }
        else at++;
      }
      end = at;
    }
    return dictionary.substring(0, start) + dictionary.substring(end);
  }
}
