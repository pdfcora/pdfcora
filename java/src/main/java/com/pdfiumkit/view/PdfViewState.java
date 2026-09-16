package com.pdfiumkit.view;

/**
 * Where a viewer is looking, in a form that survives a change of screen.
 *
 * Held in document space rather than view space: a scroll offset is in the sending
 * viewer's own pixels and means nothing elsewhere, so what travels is the page and the
 * PDF point at the centre of the viewport.
 */
public record PdfViewState(int pageIndex, double centerX, double centerY,
                           PdfZoom zoom, int rotation, Layout layout) {
  public enum Layout { SINGLE, CONTINUOUS }

  public static PdfViewState initial(PdfZoom zoom, double centerX, double centerY) {
    return new PdfViewState(0, centerX, centerY, zoom, 0, Layout.CONTINUOUS);
  }

  public PdfViewState withPage(int pageIndex) {
    return new PdfViewState(pageIndex, centerX, centerY, zoom, rotation, layout);
  }

  public PdfViewState withCenter(double x, double y) {
    return new PdfViewState(pageIndex, x, y, zoom, rotation, layout);
  }

  public PdfViewState withZoom(PdfZoom zoom) {
    return new PdfViewState(pageIndex, centerX, centerY, zoom, rotation, layout);
  }
}
