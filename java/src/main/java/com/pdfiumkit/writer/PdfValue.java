package com.pdfiumkit.writer;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The PDF values this writer can emit, and how they are serialised.
 *
 * Deliberately small: numbers, names, strings, references, arrays, dictionaries and
 * streams are all a structure tree needs. Everything is written uncompressed, because a
 * few hundred bytes saved is worth less than being able to read the output when
 * something goes wrong.
 */
public sealed interface PdfValue {
  record Num(double value) implements PdfValue {}
  record Name(String value) implements PdfValue {}
  /** A literal string; parentheses and backslashes are escaped when written. */
  record Str(String value) implements PdfValue {}
  record Bool(boolean value) implements PdfValue {}
  record Ref(int number, int generation) implements PdfValue {
    public Ref(int number) { this(number, 0); }
  }
  record Arr(List<PdfValue> items) implements PdfValue {}
  record Dict(Map<String, PdfValue> entries) implements PdfValue {}
  /** A dictionary with stream data; /Length is filled in when written. */
  record Stream(Map<String, PdfValue> entries, byte[] data) implements PdfValue {}
  /** Something already encoded, such as a value copied from the source document. */
  record Raw(byte[] bytes) implements PdfValue {}

  static PdfValue of(int value) { return new Num(value); }
  static PdfValue name(String value) { return new Name(value); }
  static PdfValue ref(int number) { return new Ref(number); }

  static Map<String, PdfValue> dict() { return new LinkedHashMap<>(); }

  /** Serialises one object: {@code N 0 obj … endobj}. */
  static byte[] object(int number, PdfValue value) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    write(out, ascii(number + " 0 obj\n"));
    write(out, serialize(value));
    write(out, ascii("\nendobj\n"));
    return out.toByteArray();
  }

  static byte[] serialize(PdfValue value) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    // `instanceof` patterns rather than a switch: switch patterns are a preview feature
    // on Java 17, and this SDK targets 17.
    if (value instanceof Num n) {
      write(out, ascii(n.value() == Math.rint(n.value())
          ? String.valueOf((long) n.value()) : String.valueOf(n.value())));
    } else if (value instanceof Name n) {
      write(out, ascii("/" + n.value()));
    } else if (value instanceof Bool b) {
      write(out, ascii(b.value() ? "true" : "false"));
    } else if (value instanceof Ref r) {
      write(out, ascii(r.number() + " " + r.generation() + " R"));
    } else if (value instanceof Raw r) {
      write(out, r.bytes());
    } else if (value instanceof Str s) {
      StringBuilder escaped = new StringBuilder("(");
      for (char c : s.value().toCharArray()) {
        if (c == '(' || c == ')' || c == '\\') escaped.append('\\');
        escaped.append(c);
      }
      write(out, ascii(escaped.append(')').toString()));
    } else if (value instanceof Arr a) {
      write(out, ascii("["));
      for (int i = 0; i < a.items().size(); i++) {
        if (i > 0) write(out, ascii(" "));
        write(out, serialize(a.items().get(i)));
      }
      write(out, ascii("]"));
    } else if (value instanceof Dict d) {
      write(out, dictionary(d.entries()));
    } else if (value instanceof Stream stream) {
      Map<String, PdfValue> entries = new LinkedHashMap<>(stream.entries());
      entries.put("Length", new Num(stream.data().length));
      write(out, dictionary(entries));
      write(out, ascii("\nstream\n"));
      write(out, stream.data());
      write(out, ascii("\nendstream"));
    }
    return out.toByteArray();
  }

  private static byte[] dictionary(Map<String, PdfValue> entries) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    write(out, ascii("<<"));
    for (Map.Entry<String, PdfValue> entry : entries.entrySet()) {
      write(out, ascii("/" + entry.getKey() + " "));
      write(out, serialize(entry.getValue()));
      write(out, ascii(" "));
    }
    write(out, ascii(">>"));
    return out.toByteArray();
  }

  private static void write(ByteArrayOutputStream out, byte[] bytes) {
    out.writeBytes(bytes);
  }

  /** PDF syntax is Latin-1, so this is the encoding throughout the writer. */
  static byte[] ascii(String value) {
    return value.getBytes(StandardCharsets.ISO_8859_1);
  }
}
