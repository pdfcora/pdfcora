package com.pdfiumkit;

import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;

/** One page of a {@link PdfDocument}. Obtained from {@link PdfDocument#page(int)}. */
public final class PdfPage {
  /** A page's size in PDF points, which is what every coordinate here is in. */
  public record Size(float width, float height) {}

  /** Where a search matched, as a character offset and length into the page's text. */
  public record Match(int start, int length) {}

  private final PdfDocument document;
  private final int index;

  PdfPage(PdfDocument document, int index) {
    this.document = document;
    this.index = index;
  }

  public int index() {
    return index;
  }

  public Size size() {
    return document.call(handle -> {
      float[] out = new float[2];
      int code = Native.pageSize(handle, index, out);
      if (code != 0) throw PdfError.fromNative(code);
      return new Size(out[0], out[1]);
    });
  }

  /** Renders at {@code width} pixels; the height follows the page's aspect ratio. */
  public BufferedImage render(int width) {
    Size size = size();
    if (size.width() <= 0 || size.height() <= 0) {
      throw new PdfError(PdfError.Code.CORRUPT, "page " + index + " has zero size");
    }
    int height = Math.max(1, Math.round(width * size.height() / size.width()));
    return render(width, height, true);
  }

  /** Renders at an explicit pixel size, ignoring the page's aspect ratio. */
  public BufferedImage render(int width, int height, boolean withAnnotations) {
    if (width <= 0 || height <= 0) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "the render size must be positive");
    }
    int[] pixels = document.call(handle -> {
      int[] out = new int[width * height];
      int code = Native.render(handle, index, width, height, withAnnotations, out);
      if (code != 0) throw PdfError.fromNative(code);
      return out;
    });
    BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
    image.setRGB(0, 0, width, height, pixels, 0, width);
    return image;
  }

  /** The page's text in reading order. */
  public String text() {
    String text = document.call(handle -> Native.pageText(handle, index));
    if (text == null) throw new PdfError(PdfError.Code.PAGE_OUT_OF_RANGE, "no page " + index);
    return text;
  }

  public int characterCount() {
    int count = document.call(handle -> Native.charCount(handle, index));
    if (count < 0) throw PdfError.fromNative(count);
    return count;
  }

  public List<Match> search(String query) {
    return search(query, false);
  }

  /** At most 1000 matches per page, which is far past what a reader would use. */
  public List<Match> search(String query, boolean caseSensitive) {
    if (query == null || query.isEmpty()) return List.of();
    return document.call(handle -> {
      int[] out = new int[2000];
      int found = Native.search(handle, index, query, caseSensitive, out);
      if (found < 0) throw PdfError.fromNative(found);
      List<Match> matches = new ArrayList<>(found);
      for (int i = 0; i < found; i++) matches.add(new Match(out[i * 2], out[i * 2 + 1]));
      return matches;
    });
  }
}
