package com.pdfcora.view;

import com.pdfcora.PdfAnnotation;

/**
 * Converts between PDF space and view space, in both directions and explicitly.
 *
 * PDF space has its origin bottom-left and a view has it top-left, so the Y flip lives
 * here rather than being applied by hand at every call site — which is where the other
 * platforms found their coordinate bugs.
 */
public record PdfViewTransform(double scale, double offsetX, double offsetY, double pageHeight) {
  /** A rectangle in view pixels, origin top-left. */
  public record ViewRect(double left, double top, double right, double bottom) {
    public double width() { return right - left; }
    public double height() { return bottom - top; }
    public double centerX() { return (left + right) / 2; }
    public double centerY() { return (top + bottom) / 2; }
  }

  public ViewRect toView(PdfAnnotation.Rect rect) {
    return new ViewRect(
        rect.left() * scale + offsetX,
        (pageHeight - rect.top()) * scale + offsetY,
        rect.right() * scale + offsetX,
        (pageHeight - rect.bottom()) * scale + offsetY);
  }

  /** The PDF point under a view point. */
  public double[] toPdf(double viewX, double viewY) {
    return new double[] {
        (viewX - offsetX) / scale,
        pageHeight - (viewY - offsetY) / scale,
    };
  }
}
