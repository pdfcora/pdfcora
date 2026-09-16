package com.pdfiumkit.writer;

import com.pdfiumkit.PdfError;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Appending an incremental update.
 *
 * The original bytes are never touched: new and replaced objects are written after them,
 * followed by a cross-reference section listing only what changed and a trailer whose
 * /Prev points at the previous one. A reader following the chain sees the new objects,
 * and the old file is still intact underneath — which is what lets an earlier signature
 * keep verifying.
 */
public final class PdfAppend {
  private PdfAppend() {}

  /** Appends `objects`, keyed by object number, and returns the whole new file. */
  public static byte[] append(byte[] base, Map<Integer, PdfValue> objects,
                              Map<String, PdfValue> extraTrailer) {
    PdfTrailer trailer = PdfTrailer.scan(base);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.writeBytes(base);
    long offset = base.length;

    // A generating application may omit the final newline; without one the first
    // appended object would run into %%EOF.
    byte last = base.length > 0 ? base[base.length - 1] : 0;
    if (last != '\n' && last != '\r') { out.writeBytes(PdfValue.ascii("\n")); offset += 1; }

    Map<Integer, Long> positions = new TreeMap<>();
    for (Map.Entry<Integer, PdfValue> entry : new TreeMap<>(objects).entrySet()) {
      positions.put(entry.getKey(), offset);
      byte[] bytes = PdfValue.object(entry.getKey(), entry.getValue());
      out.writeBytes(bytes);
      offset += bytes.length;
    }

    int highest = positions.isEmpty() ? trailer.size() - 1 : ((TreeMap<Integer, Long>) positions).lastKey();
    int size = Math.max(trailer.size(), highest + 1);

    out.writeBytes(trailer.style() == PdfTrailer.Style.TABLE
        ? xrefTable(positions, size, trailer, offset, extraTrailer)
        : xrefStream(positions, size, trailer, offset, extraTrailer));
    return out.toByteArray();
  }

  private static String trailerEntries(int size, PdfTrailer trailer, Map<String, PdfValue> extra) {
    StringBuilder entries = new StringBuilder("<< /Size ").append(size)
        .append(" /Root ").append(trailer.root())
        .append(" /Prev ").append(trailer.startXref());
    if (trailer.info() != null) entries.append(" /Info ").append(trailer.info());
    if (trailer.id() != null) entries.append(" /ID ").append(trailer.id());
    if (extra != null) {
      for (Map.Entry<String, PdfValue> entry : extra.entrySet()) {
        entries.append(" /").append(entry.getKey()).append(' ')
               .append(new String(PdfValue.serialize(entry.getValue()), java.nio.charset.StandardCharsets.ISO_8859_1));
      }
    }
    return entries.append(" >>").toString();
  }

  /**
   * The classic cross-reference table. Entries must be grouped into runs of consecutive
   * object numbers, and every line is exactly twenty bytes.
   */
  private static byte[] xrefTable(Map<Integer, Long> positions, int size, PdfTrailer trailer,
                                  long xrefOffset, Map<String, PdfValue> extra) {
    List<Integer> numbers = new ArrayList<>(positions.keySet());
    StringBuilder table = new StringBuilder("xref\n");

    for (int i = 0; i < numbers.size(); ) {
      int end = i + 1;
      while (end < numbers.size() && numbers.get(end) == numbers.get(end - 1) + 1) end++;
      table.append(numbers.get(i)).append(' ').append(end - i).append('\n');
      for (int j = i; j < end; j++) {
        table.append(String.format("%010d 00000 n \n", positions.get(numbers.get(j))));
      }
      i = end;
    }

    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.writeBytes(PdfValue.ascii(table.toString()));
    out.writeBytes(PdfValue.ascii("trailer\n"));
    out.writeBytes(PdfValue.ascii(trailerEntries(size, trailer, extra)));
    out.writeBytes(PdfValue.ascii("\nstartxref\n" + xrefOffset + "\n%%EOF\n"));
    return out.toByteArray();
  }

  /**
   * A cross-reference stream, for files written that way. The stream is its own object,
   * so it takes a number and must list itself. Written uncompressed — an undecodable
   * stream is a far worse failure than a large one.
   */
  private static byte[] xrefStream(Map<Integer, Long> positions, int size, PdfTrailer trailer,
                                   long xrefOffset, Map<String, PdfValue> extra) {
    int streamNumber = size;
    Map<Integer, Long> all = new TreeMap<>(positions);
    all.put(streamNumber, xrefOffset);

    List<Integer> numbers = new ArrayList<>(all.keySet());
    List<Integer> index = new ArrayList<>();
    List<long[]> rows = new ArrayList<>();
    for (int i = 0; i < numbers.size(); ) {
      int end = i + 1;
      while (end < numbers.size() && numbers.get(end) == numbers.get(end - 1) + 1) end++;
      index.add(numbers.get(i));
      index.add(end - i);
      for (int j = i; j < end; j++) rows.add(new long[] { 1, all.get(numbers.get(j)), 0 });
      i = end;
    }

    // /W [1 4 2]: a type, a four-byte offset and a two-byte generation.
    byte[] body = new byte[rows.size() * 7];
    for (int i = 0; i < rows.size(); i++) {
      long[] row = rows.get(i);
      int at = i * 7;
      body[at] = (byte) row[0];
      body[at + 1] = (byte) (row[1] >>> 24);
      body[at + 2] = (byte) (row[1] >>> 16);
      body[at + 3] = (byte) (row[1] >>> 8);
      body[at + 4] = (byte) row[1];
      body[at + 5] = (byte) (row[2] >> 8);
      body[at + 6] = (byte) row[2];
    }

    StringBuilder head = new StringBuilder(trailerEntries(streamNumber + 1, trailer, extra));
    head.setLength(head.length() - 3);   // drop the closing ">>"
    head.append(" /Type /XRef /W [1 4 2] /Index [");
    for (int i = 0; i < index.size(); i++) head.append(i > 0 ? " " : "").append(index.get(i));
    head.append("] /Length ").append(body.length).append(" >>");

    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.writeBytes(PdfValue.ascii(streamNumber + " 0 obj\n"));
    out.writeBytes(PdfValue.ascii(head.toString()));
    out.writeBytes(PdfValue.ascii("\nstream\n"));
    out.writeBytes(body);
    out.writeBytes(PdfValue.ascii("\nendstream\nendobj\n"));
    out.writeBytes(PdfValue.ascii("startxref\n" + xrefOffset + "\n%%EOF\n"));
    return out.toByteArray();
  }
}
