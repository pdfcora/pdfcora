package com.pdfiumkit;

import java.util.ArrayList;
import java.util.List;

/**
 * What to remove, and what removing it did.
 *
 * Redaction takes the content out of the saved bytes rather than covering it. The
 * document must then be saved in full — which {@link PdfDocument#toByteArray()} always
 * does — because an incremental save would keep the original content stream in the file
 * and defeat the exercise.
 */
public final class PdfRedaction {
  private PdfRedaction() {}

  /** A rectangle on one page, or every match of a phrase across the document. */
  public sealed interface Target {
    record Region(int pageIndex, PdfAnnotation.Rect rect) implements Target {}
    record TextMatches(String query, boolean caseSensitive) implements Target {
      public TextMatches(String query) { this(query, false); }
    }
  }

  /** What was removed. `pages` are the pages that changed. */
  public record Report(int textObjects, int textObjectsSplit, int images, int paths,
                       int annotations, List<Integer> pages) {
    public boolean changedAnything() {
      return textObjects + textObjectsSplit + images + paths + annotations > 0;
    }
  }

  static Report apply(PdfDocument document, List<Target> targets) {
    List<Integer> changed = new ArrayList<>();
    int[] total = new int[5];

    for (int pageIndex = 0; pageIndex < document.pageCount(); pageIndex++) {
      List<PdfAnnotation.Rect> regions = regionsFor(document, targets, pageIndex);
      if (regions.isEmpty()) continue;

      float[] flat = new float[regions.size() * 4];
      int at = 0;
      for (PdfAnnotation.Rect rect : regions) {
        flat[at++] = rect.left(); flat[at++] = rect.bottom();
        flat[at++] = rect.right(); flat[at++] = rect.top();
      }

      final int page = pageIndex;
      int[] counts = new int[5];
      int code = document.call(handle -> Native.redactPage(handle, page, flat, counts));
      if (code != 0) throw PdfError.fromNative(code);

      boolean any = false;
      for (int i = 0; i < counts.length; i++) { total[i] += counts[i]; any |= counts[i] > 0; }
      if (any) changed.add(pageIndex);
    }
    return new Report(total[0], total[1], total[2], total[3], total[4], List.copyOf(changed));
  }

  /** Regions on one page: the ones named directly, plus every match of every phrase. */
  private static List<PdfAnnotation.Rect> regionsFor(PdfDocument document, List<Target> targets, int pageIndex) {
    List<PdfAnnotation.Rect> regions = new ArrayList<>();
    for (Target target : targets) {
      if (target instanceof Target.Region region && region.pageIndex() == pageIndex) {
        regions.add(region.rect());
      } else if (target instanceof Target.TextMatches phrase) {
        PdfPage page = document.page(pageIndex);
        for (PdfPage.Match match : page.search(phrase.query(), phrase.caseSensitive())) {
          regions.addAll(rectsFor(document, pageIndex, match));
        }
      }
    }
    return regions;
  }

  private static List<PdfAnnotation.Rect> rectsFor(PdfDocument document, int pageIndex, PdfPage.Match match) {
    float[] out = new float[64 * 4];
    int found = document.call(handle ->
        Native.matchRects(handle, pageIndex, match.start(), match.length(), out));
    if (found < 0) throw PdfError.fromNative(found);
    List<PdfAnnotation.Rect> rects = new ArrayList<>(found);
    for (int i = 0; i < found; i++) {
      rects.add(new PdfAnnotation.Rect(out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]));
    }
    return rects;
  }
}
