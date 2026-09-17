package com.pdfcora;

/**
 * An annotation on a page, as PDFium reports it.
 *
 * `index` addresses it for removal and is the position in the page's annotation list, so
 * it changes when an earlier annotation is removed.
 */
public record PdfAnnotation(int index, Kind kind, Rect rect, String contents) {
  /** A rectangle in PDF space, origin bottom-left, normalised so left ≤ right. */
  public record Rect(float left, float bottom, float right, float top) {
    public float width() { return right - left; }
    public float height() { return top - bottom; }
  }

  /**
   * The subtypes PDFium distinguishes. UNKNOWN carries anything not modelled here rather
   * than dropping it, which is the rule on every platform.
   */
  public enum Kind {
    UNKNOWN, TEXT, LINK, FREE_TEXT, LINE, SQUARE, CIRCLE, POLYGON, POLYLINE,
    HIGHLIGHT, UNDERLINE, SQUIGGLY, STRIKEOUT, STAMP, CARET, INK, POPUP, FILE_ATTACHMENT,
    SOUND, MOVIE, WIDGET, SCREEN, PRINTER_MARK, TRAP_NET, WATERMARK, THREE_D, RICH_MEDIA,
    XFA_WIDGET, REDACT;

    /** PDFium's subtype numbering, in the order its own enum declares. */
    static Kind fromNative(int value) {
      Kind[] values = values();
      return value >= 0 && value < values.length ? values[value] : UNKNOWN;
    }

    int toNative() {
      return ordinal();
    }
  }
}
