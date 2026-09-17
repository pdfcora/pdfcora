package com.pdfcora;

/** A form field on a page. `index` addresses it when setting a value. */
public record PdfFormField(int index, Kind kind, String name, String value,
                           boolean checked, boolean readOnly, PdfAnnotation.Rect rect) {
  /** The field kinds PDFium reports. */
  public enum Kind {
    UNKNOWN, PUSH_BUTTON, CHECK_BOX, RADIO_BUTTON, COMBO_BOX, LIST_BOX, TEXT_FIELD, SIGNATURE;

    static Kind fromNative(int value) {
      Kind[] values = values();
      return value >= 0 && value < values.length ? values[value] : UNKNOWN;
    }
  }

  /** True for a checkbox or radio button, the two kinds {@code setChecked} applies to. */
  public boolean isToggle() {
    return kind == Kind.CHECK_BOX || kind == Kind.RADIO_BUTTON;
  }
}
