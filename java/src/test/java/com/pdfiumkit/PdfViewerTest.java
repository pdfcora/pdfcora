package com.pdfiumkit;

import static org.junit.jupiter.api.Assertions.*;

import com.pdfiumkit.view.PdfViewState;
import com.pdfiumkit.view.PdfViewTransform;
import com.pdfiumkit.view.PdfViewer;
import com.pdfiumkit.view.PdfZoom;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The viewer's logic, which has no UI and so is testable on its own. */
class PdfViewerTest {
  private static final Path CONTRACT =
      Path.of(System.getProperty("pdfiumkit.conformance")).resolve("fixtures/contract.pdf");

  private static PdfViewer viewer(PdfDocument document) {
    return PdfViewer.open(document, 800, 1000);
  }

  @Test
  void opensFittedToTheViewportWidth() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      PdfPage.Size page = document.page(0).size();

      assertEquals(PdfZoom.Mode.FIT_WIDTH, v.state().zoom().mode());
      assertEquals(800 / (double) page.width(), v.state().zoom().scale(), 1e-9);
      assertEquals(0, v.state().pageIndex());
    }
  }

  @Test
  void theZoomLadderStepsToTheNextRungNotAFixedIndex() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      double fit = v.state().zoom().scale();     // about 1.29 for a 612pt page in 800px

      v.zoomIn();
      assertTrue(v.state().zoom().scale() > fit);
      assertEquals(PdfZoom.Mode.FREE, v.state().zoom().mode(), "a stepped zoom is the user's own");
      assertTrue(PdfZoom.STEPS.contains(v.state().zoom().scale()));

      v.zoomOut();
      assertTrue(v.state().zoom().scale() < 1.5);
      // The ladder ends rather than running away.
      for (int i = 0; i < 20; i++) v.zoomOut();
      assertEquals(PdfZoom.STEPS.get(0), v.state().zoom().scale());
      for (int i = 0; i < 20; i++) v.zoomIn();
      assertEquals(PdfZoom.STEPS.get(PdfZoom.STEPS.size() - 1), v.state().zoom().scale());
    }
  }

  @Test
  void aFitIsRederivedWhenTheWindowChangesAndAFreeZoomSurvives() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      v.setViewport(400, 1000);
      assertEquals(400 / (double) document.page(0).size().width(), v.state().zoom().scale(), 1e-9);

      v.zoomIn();
      double chosen = v.state().zoom().scale();
      v.setViewport(1200, 1000);
      assertEquals(chosen, v.state().zoom().scale(), 1e-9, "the user's zoom is not overridden");
    }
  }

  @Test
  void paginationClampsToTheDocument() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      v.nextPage();
      assertEquals(1, v.state().pageIndex());
      v.goToPage(99);
      assertEquals(document.pageCount() - 1, v.state().pageIndex());
      v.goToPage(-5);
      assertEquals(0, v.state().pageIndex());
    }
  }

  @Test
  void viewAndPdfCoordinatesRoundTrip() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      PdfAnnotation.Rect rect = new PdfAnnotation.Rect(72, 700, 300, 720);

      PdfViewTransform.ViewRect view = v.transform().toView(rect);
      assertTrue(view.top() < view.bottom(), "view space runs downwards");
      assertEquals(rect.width() * v.state().zoom().scale(), view.width(), 1e-6);

      double[] back = v.transform().toPdf(view.left(), view.top());
      assertEquals(rect.left(), back[0], 1e-6);
      assertEquals(rect.top(), back[1], 1e-6);
    }
  }

  @Test
  void stateTravelsToAnotherViewerAndAFitIsRefittedThere() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer presenter = PdfViewer.open(document, 800, 1000);
      PdfViewer follower = PdfViewer.open(document, 400, 600);

      presenter.goToPage(1);
      presenter.zoomIn();
      follower.apply(presenter.state());
      assertEquals(1, follower.state().pageIndex());
      assertEquals(presenter.state().zoom().scale(), follower.state().zoom().scale(), 1e-9,
          "a free zoom is adopted literally");

      presenter.fitWidth();
      follower.apply(presenter.state());
      assertEquals(400 / (double) document.page(1).size().width(), follower.state().zoom().scale(), 1e-9,
          "a fit is re-derived for the follower's own window");
    }
  }

  @Test
  void changesAreAnnounced() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      List<PdfViewState> seen = new ArrayList<>();
      v.onChange(seen::add);

      v.zoomIn();
      v.nextPage();
      assertEquals(2, seen.size());
      assertEquals(1, seen.get(1).pageIndex());
    }
  }

  @Test
  void marksAreFoundByPointAndToggled() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      v.setMarks(List.of(new PdfViewer.Mark("m1", 0,
          List.of(new PdfAnnotation.Rect(72, 700, 300, 720)), PdfViewer.Mark.State.PENDING, "Anna")));

      assertEquals("m1", v.markAt(0, 100, 710));
      assertNull(v.markAt(0, 500, 710), "outside the rect");
      assertNull(v.markAt(1, 100, 710), "another page");

      v.toggleMark("m1");
      assertEquals(PdfViewer.Mark.State.ACCEPTED, v.marks().get(0).state());
      v.setAllMarks(PdfViewer.Mark.State.REJECTED);
      assertEquals(PdfViewer.Mark.State.REJECTED, v.marks().get(0).state());
    }
  }

  @Test
  void rendersAtTheZoomedSize() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfViewer v = viewer(document);
      assertEquals(800, v.render().getWidth(), 1, "fitted to the viewport");
      assertEquals(1600, v.render(2.0).getWidth(), 2, "twice as many device pixels");
    }
  }
}
