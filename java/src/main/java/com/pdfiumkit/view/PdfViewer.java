package com.pdfiumkit.view;

import com.pdfiumkit.PdfAnnotation;
import com.pdfiumkit.PdfDocument;
import com.pdfiumkit.PdfPage;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * The viewer's logic with no user interface: which page, how magnified, where the centre
 * is, which tool is active and which regions are marked for review.
 *
 * The state is a value, so it can be sent to another device and adopted there — which is
 * how the iOS, Android and web viewers stay in step. Nothing here draws; rendering is
 * {@link #render()}, and the app decides what to do with the image.
 */
public final class PdfViewer {
  /** A region drawn over a page for review, such as a redaction suggestion. */
  public record Mark(String id, int pageIndex, List<PdfAnnotation.Rect> rects, State state, String label) {
    public enum State { PENDING, ACCEPTED, REJECTED }

    public Mark withState(State next) {
      return new Mark(id, pageIndex, rects, next, label);
    }
  }

  /** What a drag on the page means. Part of the state so peers agree on it. */
  public enum Tool { SELECT, INK, NOTE, HIGHLIGHT, REDACT }

  private final PdfDocument document;
  private final int pageCount;
  private double viewportWidth;
  private double viewportHeight;
  private double pageWidth;
  private double pageHeight;
  private PdfViewState state;
  private Tool tool = Tool.SELECT;
  private final List<Mark> marks = new ArrayList<>();
  private final List<Consumer<PdfViewState>> listeners = new ArrayList<>();

  private PdfViewer(PdfDocument document, int pageCount, double viewportWidth, double viewportHeight,
                    double pageWidth, double pageHeight, PdfViewState state) {
    this.document = document;
    this.pageCount = pageCount;
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.state = state;
  }

  /** Opens a viewer on a document, fitted to the viewport's width. */
  public static PdfViewer open(PdfDocument document, double viewportWidth, double viewportHeight) {
    PdfPage.Size size = document.page(0).size();
    PdfZoom zoom = PdfZoom.fittingWidth(viewportWidth, size.width());
    return new PdfViewer(document, document.pageCount(), viewportWidth, viewportHeight,
        size.width(), size.height(),
        PdfViewState.initial(zoom, size.width() / 2, size.height() / 2));
  }

  public PdfViewState state() {
    return state;
  }

  public Tool tool() {
    return tool;
  }

  public void setTool(Tool tool) {
    this.tool = tool;
  }

  /** Called whenever the state changes, which is what a sync transport sends. */
  public void onChange(Consumer<PdfViewState> listener) {
    listeners.add(listener);
  }

  // ---- Viewport --------------------------------------------------------------------

  /**
   * A fit is a promise about the window, so it is re-derived when the window changes.
   * A free zoom is the user's deliberate choice and survives.
   */
  public void setViewport(double width, double height) {
    viewportWidth = width;
    viewportHeight = height;
    if (state.zoom().mode() != PdfZoom.Mode.FREE) update(state.withZoom(refit(state.zoom().mode())));
    else update(state);
  }

  public void goToPage(int index) {
    int page = Math.max(0, Math.min(pageCount - 1, index));
    PdfPage.Size size = document.page(page).size();
    pageWidth = size.width();
    pageHeight = size.height();
    PdfZoom zoom = state.zoom().mode() == PdfZoom.Mode.FREE ? state.zoom() : refit(state.zoom().mode());
    update(new PdfViewState(page, pageWidth / 2, pageHeight / 2, zoom, state.rotation(), state.layout()));
  }

  public void nextPage() {
    goToPage(state.pageIndex() + 1);
  }

  public void previousPage() {
    goToPage(state.pageIndex() - 1);
  }

  public void scrollTo(double centerX, double centerY) {
    update(state.withCenter(centerX, centerY));
  }

  /** Moves the centre by a delta in view pixels. */
  public void scrollBy(double deltaX, double deltaY) {
    double scale = state.zoom().scale();
    update(state.withCenter(state.centerX() + deltaX / scale, state.centerY() - deltaY / scale));
  }

  public void zoomTo(PdfZoom zoom) {
    update(state.withZoom(zoom));
  }

  public void zoomIn() {
    zoomTo(state.zoom().stepped(1));
  }

  public void zoomOut() {
    zoomTo(state.zoom().stepped(-1));
  }

  public void fitWidth() {
    zoomTo(refit(PdfZoom.Mode.FIT_WIDTH));
  }

  public void fitPage() {
    zoomTo(refit(PdfZoom.Mode.FIT_PAGE));
  }

  /** Adopts a state from elsewhere — another device, or a restored session. */
  public void apply(PdfViewState incoming) {
    int page = Math.max(0, Math.min(pageCount - 1, incoming.pageIndex()));
    if (page != state.pageIndex()) {
      PdfPage.Size size = document.page(page).size();
      pageWidth = size.width();
      pageHeight = size.height();
    }
    // A fit means "fit your own window", so it is re-derived here rather than adopted.
    PdfZoom zoom = incoming.zoom().mode() == PdfZoom.Mode.FREE ? incoming.zoom() : refit(incoming.zoom().mode());
    update(new PdfViewState(page, incoming.centerX(), incoming.centerY(), zoom,
        incoming.rotation(), incoming.layout()));
  }

  // ---- Drawing ---------------------------------------------------------------------

  /** Converts between PDF space and view pixels, both ways. */
  public PdfViewTransform transform() {
    double scale = state.zoom().scale();
    double offsetX = viewportWidth / 2 - state.centerX() * scale;
    double offsetY = viewportHeight / 2 - (pageHeight - state.centerY()) * scale;
    return new PdfViewTransform(scale, offsetX, offsetY, pageHeight);
  }

  /** Renders the current page at the zoomed size, so text stays sharp. */
  public BufferedImage render() {
    return render(1.0);
  }

  /** {@code pixelRatio} is device pixels per logical pixel, for a high-density screen. */
  public BufferedImage render(double pixelRatio) {
    int width = (int) Math.max(1, Math.round(pageWidth * state.zoom().scale() * pixelRatio));
    return document.page(state.pageIndex()).render(width);
  }

  // ---- Marks -----------------------------------------------------------------------
  //
  // Local to this viewer: marks never travel and never touch the document.

  public List<Mark> marks() {
    return List.copyOf(marks);
  }

  public void setMarks(List<Mark> next) {
    marks.clear();
    marks.addAll(next);
  }

  /** The mark under a PDF point, or null. Used to accept or reject by tapping. */
  public String markAt(int pageIndex, double x, double y) {
    for (Mark mark : marks) {
      if (mark.pageIndex() != pageIndex) continue;
      for (PdfAnnotation.Rect rect : mark.rects()) {
        if (x >= rect.left() && x <= rect.right() && y >= rect.bottom() && y <= rect.top()) return mark.id();
      }
    }
    return null;
  }

  /** Cycles a mark between pending and accepted, which is what a tap does. */
  public void toggleMark(String id) {
    for (int i = 0; i < marks.size(); i++) {
      Mark mark = marks.get(i);
      if (!mark.id().equals(id)) continue;
      marks.set(i, mark.withState(mark.state() == Mark.State.ACCEPTED
          ? Mark.State.PENDING : Mark.State.ACCEPTED));
      return;
    }
  }

  public void setAllMarks(Mark.State state) {
    for (int i = 0; i < marks.size(); i++) marks.set(i, marks.get(i).withState(state));
  }

  // ---- internals -------------------------------------------------------------------

  private PdfZoom refit(PdfZoom.Mode mode) {
    return mode == PdfZoom.Mode.FIT_PAGE
        ? PdfZoom.fittingSize(viewportWidth, viewportHeight, pageWidth, pageHeight)
        : PdfZoom.fittingWidth(viewportWidth, pageWidth);
  }

  private void update(PdfViewState next) {
    state = next;
    for (Consumer<PdfViewState> listener : listeners) listener.accept(next);
  }
}
