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

  /**
   * The body of object `number`, without its header and `endobj`.
   *
   * The last definition wins: an incremental update appends the new version of an object
   * after the old one, so a file that has already been signed or tagged would otherwise
   * be read back at the revision before that change.
   */
  public String body(int number) {
    Matcher header = Pattern.compile("(?:^|[\\s>])" + number + "\\s+0\\s+obj\\b").matcher(text);
    int start = -1;
    while (header.find()) start = header.end();
    if (start < 0) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION,
          "object " + number + " is not written plainly; a document using object streams cannot be tagged here");
    }
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
    return mergeInto(inner(number), additions);
  }

  /** The same merge over a dictionary the caller already holds, without its `<<` and `>>`. */
  public static PdfValue mergeInto(String inner, String additions) {
    String merged = inner;
    for (String key : keysOf(additions)) merged = removeEntry(merged, key);
    return new PdfValue.Raw(PdfValue.ascii("<<" + merged + " " + additions + ">>"));
  }

  /** Object `number`'s dictionary without its `<<` and `>>`. */
  public String inner(int number) {
    String body = body(number).trim();
    int open = body.indexOf("<<");
    int close = body.lastIndexOf(">>");
    if (open < 0 || close < 0) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "object " + number + " is not a dictionary");
    }
    return body.substring(open + 2, close);
  }

  /** The text of one entry's value, or null when the dictionary has no such key. */
  public static String entryOf(String dictionary, String key) {
    int[] span = spanOf(dictionary, key);
    return span == null ? null : dictionary.substring(span[1], span[2]).trim();
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
    int[] span = spanOf(dictionary, key);
    return span == null ? dictionary : dictionary.substring(0, span[0]) + dictionary.substring(span[2]);
  }

  /**
   * Where one `/Key value` pair sits: `{ pairStart, valueStart, end }`.
   *
   * A dictionary or array value is followed to its matching close, counting nesting, so
   * an entry is never cut in half.
   */
  private static int[] spanOf(String dictionary, String key) {
    Matcher m = Pattern.compile("/" + key + "\\s*(<<|\\[|/\\w+|\\d+\\s+\\d+\\s+R|\\d+|true|false|\\([^)]*\\))")
        .matcher(dictionary);
    if (!m.find()) return null;
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
    return new int[] { m.start(), m.start(1), end };
  }
}
