package com.pdfcora;

/** An XFDF element import did not apply, and why. {@code element} is the XFDF element name. */
public record PdfXfdfSkip(String element, Integer page, Reason reason) {
  public enum Reason {
    UNSUPPORTED_TYPE("unsupportedType"), UNKNOWN_FIELD("unknownField"), READ_ONLY_FIELD("readOnlyField"),
    INVALID_VALUE("invalidValue"), PAGE_OUT_OF_RANGE("pageOutOfRange"), MISSING_ATTRIBUTE("missingAttribute"),
    WRITE_FAILED("writeFailed");

    private final String wire;

    Reason(String wire) { this.wire = wire; }

    /** The name used in XFDF reports on every platform, e.g. {@code unknownField}. */
    public String wire() { return wire; }

    public static Reason fromWire(String wire) {
      for (Reason r : values()) if (r.wire.equals(wire)) return r;
      throw new IllegalArgumentException(wire);
    }
  }
}
