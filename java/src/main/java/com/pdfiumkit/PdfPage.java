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

  /** A point in PDF space, origin bottom-left. */
  public record Point(float x, float y) {}

  /** Four corners of a region, the shape text markup is drawn over. */
  public record Quad(float x1, float y1, float x2, float y2,
                     float x3, float y3, float x4, float y4) {
    /** The common case: a rectangle. */
    public static Quad of(PdfAnnotation.Rect rect) {
      return new Quad(rect.left(), rect.top(), rect.right(), rect.top(),
                      rect.left(), rect.bottom(), rect.right(), rect.bottom());
    }
  }

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

  // ---- Annotations ----------------------------------------------------------------

  /** Every annotation on the page, in document order. */
  public List<PdfAnnotation> annotations() {
    return document.call(handle -> {
      int count = Native.annotationCount(handle, index);
      if (count < 0) throw PdfError.fromNative(count);
      List<PdfAnnotation> out = new ArrayList<>(count);
      for (int at = 0; at < count; at++) {
        float[] info = new float[5];
        String contents = Native.annotation(handle, index, at, info);
        if (contents == null) continue;
        out.add(new PdfAnnotation(at, PdfAnnotation.Kind.fromNative((int) info[0]),
            new PdfAnnotation.Rect(info[1], info[2], info[3], info[4]), contents));
      }
      return out;
    });
  }

  /** Draws freehand strokes. Returns the new annotation's index. */
  public int addInk(List<List<Point>> strokes, int red, int green, int blue, float lineWidth) {
    int total = strokes.stream().mapToInt(List::size).sum();
    float[] flat = new float[total * 2];
    int[] lengths = new int[strokes.size()];
    int at = 0;
    for (int s = 0; s < strokes.size(); s++) {
      lengths[s] = strokes.get(s).size();
      for (Point point : strokes.get(s)) { flat[at++] = point.x(); flat[at++] = point.y(); }
    }
    return created(document.call(handle -> Native.addInk(handle, index, flat, lengths, red, green, blue, lineWidth)));
  }

  public int addInk(List<List<Point>> strokes) {
    return addInk(strokes, 0, 0, 0, 2f);
  }

  /** Highlights the quads, which are usually the rectangles a text search returned. */
  public int addHighlight(List<Quad> quads) {
    return addMarkup(PdfAnnotation.Kind.HIGHLIGHT, quads, 255, 255, 0, 128);
  }

  public int addUnderline(List<Quad> quads) {
    return addMarkup(PdfAnnotation.Kind.UNDERLINE, quads, 0, 0, 255, 255);
  }

  public int addStrikeout(List<Quad> quads) {
    return addMarkup(PdfAnnotation.Kind.STRIKEOUT, quads, 255, 0, 0, 255);
  }

  /** Text markup of any of the three kinds, with an explicit colour. */
  public int addMarkup(PdfAnnotation.Kind kind, List<Quad> quads, int red, int green, int blue, int alpha) {
    if (quads.isEmpty()) throw new PdfError(PdfError.Code.INVALID_OPERATION, "markup needs at least one quad");
    float[] flat = new float[quads.size() * 8];
    int at = 0;
    for (Quad quad : quads) {
      flat[at++] = quad.x1(); flat[at++] = quad.y1();
      flat[at++] = quad.x2(); flat[at++] = quad.y2();
      flat[at++] = quad.x3(); flat[at++] = quad.y3();
      flat[at++] = quad.x4(); flat[at++] = quad.y4();
    }
    return created(document.call(handle ->
        Native.addMarkup(handle, index, kind.toNative(), flat, red, green, blue, alpha)));
  }

  /** A sticky note at a point. */
  public int addNote(float x, float y, String contents) {
    return created(document.call(handle -> Native.addNote(handle, index, x, y, contents)));
  }

  /** Removes one annotation by its index; later annotations shift down. */
  public void removeAnnotation(int at) {
    int code = document.call(handle -> Native.removeAnnotation(handle, index, at));
    if (code != 0) throw PdfError.fromNative(code);
  }

  // ---- Form fields ----------------------------------------------------------------

  /** The form fields on this page, in document order. */
  public List<PdfFormField> formFields() {
    return document.call(handle -> {
      int count = Native.annotationCount(handle, index);
      if (count < 0) throw PdfError.fromNative(count);
      List<PdfFormField> fields = new ArrayList<>();
      for (int at = 0; at < count; at++) {
        int[] info = new int[3];
        float[] rect = new float[4];
        String both = Native.formField(handle, index, at, info, rect);
        if (both == null) continue;   // not a widget
        int split = both.indexOf('\n');
        fields.add(new PdfFormField(at, PdfFormField.Kind.fromNative(info[0]),
            both.substring(0, split), both.substring(split + 1),
            info[2] == 1, (info[1] & 1) != 0,
            new PdfAnnotation.Rect(rect[0], rect[1], rect[2], rect[3])));
      }
      return fields;
    });
  }

  /** Sets a text field's value, addressed by the field's {@code index}. */
  public void setFieldText(int fieldIndex, String value) {
    int code = document.call(handle -> Native.setFieldText(handle, index, fieldIndex, value));
    if (code != 0) throw PdfError.fromNative(code);
  }

  /** Checks or unchecks a checkbox or radio button. */
  public void setFieldChecked(int fieldIndex, boolean checked) {
    int code = document.call(handle -> Native.setFieldChecked(handle, index, fieldIndex, checked));
    if (code != 0) throw PdfError.fromNative(code);
  }

  private static int created(int result) {
    if (result < 0) throw PdfError.fromNative(result);
    return result;
  }

  // ---- Text -----------------------------------------------------------------------

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
