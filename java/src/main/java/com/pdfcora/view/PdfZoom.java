package com.pdfcora.view;

import java.util.List;

/**
 * How magnified the page is, and how that was arrived at.
 *
 * A type rather than a number because three callers need three different things from it:
 * rendering needs the absolute {@code scale}, syncing needs the {@code mode} — a peer
 * receiving {@code FIT_WIDTH} fits its own window, while {@code FREE} it adopts literally
 * — and a toolbar needs a percentage, which is derived so it cannot go stale when the
 * window resizes.
 */
public record PdfZoom(double scale, Mode mode) {
  public enum Mode { FIT_WIDTH, FIT_PAGE, FREE }

  /** The rungs a zoom button steps along. */
  public static final List<Double> STEPS = List.of(0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0);

  /** A degenerate page would give an infinite scale and poison every coordinate. */
  private static double safeRatio(double available, double page) {
    return page > 0 ? available / page : 1;
  }

  public static PdfZoom fittingWidth(double width, double pageWidth) {
    return new PdfZoom(safeRatio(width, pageWidth), Mode.FIT_WIDTH);
  }

  public static PdfZoom fittingSize(double width, double height, double pageWidth, double pageHeight) {
    // Whichever dimension runs out first decides, or the page overflows the other.
    return new PdfZoom(Math.min(safeRatio(width, pageWidth), safeRatio(height, pageHeight)), Mode.FIT_PAGE);
  }

  /** 1:1 based, as Acrobat and Preview mean it. */
  public int percentage() {
    return (int) Math.round(scale * 100);
  }

  /** Fit based, as most viewers mean it: 100% is whatever fills the window. */
  public int percentageOfFit(double fitScale) {
    return fitScale > 0 ? (int) Math.round(scale / fitScale * 100) : 100;
  }

  /**
   * Moves one rung along the ladder. A fit scale is almost never exactly on a rung, so
   * stepping up goes to the first rung above the current scale rather than to a fixed
   * index. The result is always {@code FREE}: the user picked this number, so a peer
   * adopts it rather than re-deriving its own fit.
   */
  public PdfZoom stepped(int direction) {
    double next;
    if (direction > 0) {
      next = STEPS.stream().filter(s -> s > scale + 1e-9).findFirst().orElse(STEPS.get(STEPS.size() - 1));
    } else {
      next = STEPS.stream().filter(s -> s < scale - 1e-9).reduce((a, b) -> b).orElse(STEPS.get(0));
    }
    return new PdfZoom(next, Mode.FREE);
  }
}
