package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Annotations and form fields, against the fixtures the other platforms use. */
class PdfEditingTest {
  private static final Path CONFORMANCE = Path.of(System.getProperty("pdfcora.conformance"));
  private static final Path CONTRACT = CONFORMANCE.resolve("fixtures/contract.pdf");
  private static final Path TEXT_FORM = CONFORMANCE.resolve("corpus/text_form.pdf");
  private static final Path CHECKBOX_FORM = CONFORMANCE.resolve("corpus/click_form.pdf");
  private static final Path ANNOTATED = CONFORMANCE.resolve("corpus/annots_action_handling.pdf");

  @Test
  void anInkAnnotationsRectangleCoversItsStrokes() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfPage page = document.page(0);
      int created = page.addInk(List.of(List.of(new PdfPage.Point(300, 600), new PdfPage.Point(400, 700))), 0, 0, 0, 2);
      PdfAnnotation.Rect rect = page.annotations().get(created).rect();
      // PDFium grows the rectangle by half the line width when it draws the appearance.
      assertTrue(rect.left() <= 300 && rect.bottom() <= 600 && rect.right() >= 400 && rect.top() >= 700, rect.toString());
      assertTrue(rect.left() >= 298 && rect.right() <= 402, rect.toString());
    }
  }

  @Test
  void readsTheAnnotationsAlreadyOnAPage() throws IOException {
    try (PdfDocument document = PdfDocument.open(ANNOTATED)) {
      List<PdfAnnotation> annotations = document.page(0).annotations();
      assertFalse(annotations.isEmpty());
      for (PdfAnnotation annotation : annotations) {
        assertNotNull(annotation.kind());
        assertNotNull(annotation.contents());
        assertTrue(annotation.rect().right() >= annotation.rect().left());
      }
    }
  }

  @Test
  void addsInkAndItSurvivesASaveAndReopen() throws IOException {
    byte[] saved;
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfPage page = document.page(0);
      int before = page.annotations().size();
      int created = page.addInk(List.of(List.of(
          new PdfPage.Point(80, 600), new PdfPage.Point(200, 640), new PdfPage.Point(300, 600))));

      assertEquals(before, created, "the new annotation is appended");
      List<PdfAnnotation> after = page.annotations();
      assertEquals(before + 1, after.size());
      assertEquals(PdfAnnotation.Kind.INK, after.get(created).kind());
      saved = document.toByteArray();
    }
    try (PdfDocument reopened = PdfDocument.open(saved)) {
      assertTrue(reopened.page(0).annotations().stream()
          .anyMatch(a -> a.kind() == PdfAnnotation.Kind.INK), "the ink is in the saved bytes");
    }
  }

  @Test
  void addsTextMarkupOverTheRectanglesSearchReturned() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfPage page = document.page(0);
      int highlight = page.addHighlight(List.of(
          new PdfPage.Quad(72, 720, 300, 720, 72, 700, 300, 700)));
      int underline = page.addUnderline(List.of(
          new PdfPage.Quad(72, 690, 300, 690, 72, 670, 300, 670)));

      List<PdfAnnotation> annotations = page.annotations();
      assertEquals(PdfAnnotation.Kind.HIGHLIGHT, annotations.get(highlight).kind());
      assertEquals(PdfAnnotation.Kind.UNDERLINE, annotations.get(underline).kind());
      // The rect is derived from the quads, so it covers them.
      assertTrue(annotations.get(highlight).rect().width() >= 228 - 1);
    }
  }

  @Test
  void addsANoteWithItsText() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfPage page = document.page(0);
      int at = page.addNote(100, 500, "Check clause 4.2");
      PdfAnnotation note = page.annotations().get(at);

      assertEquals(PdfAnnotation.Kind.TEXT, note.kind());
      assertEquals("Check clause 4.2", note.contents());
    }
  }

  @Test
  void removesAnAnnotation() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      PdfPage page = document.page(0);
      int at = page.addNote(100, 500, "temporary");
      assertEquals(at + 1, page.annotations().size());

      page.removeAnnotation(at);
      assertEquals(at, page.annotations().size());
      assertEquals(PdfError.Code.PAGE_OUT_OF_RANGE,
          assertThrows(PdfError.class, () -> page.removeAnnotation(99)).code());
    }
  }

  @Test
  void readsAndFillsATextField() throws IOException {
    byte[] saved;
    try (PdfDocument document = PdfDocument.open(TEXT_FORM)) {
      PdfPage page = document.page(0);
      List<PdfFormField> fields = page.formFields();
      assertFalse(fields.isEmpty());

      PdfFormField field = fields.get(0);
      assertEquals(PdfFormField.Kind.TEXT_FIELD, field.kind());
      assertFalse(field.name().isEmpty());

      page.setFieldText(field.index(), "Jane Doe");
      assertEquals("Jane Doe", page.formFields().get(0).value());
      saved = document.toByteArray();
    }
    try (PdfDocument reopened = PdfDocument.open(saved)) {
      assertEquals("Jane Doe", reopened.page(0).formFields().get(0).value(),
          "the value is in the saved bytes, not just in memory");
    }
  }

  @Test
  void checksACheckbox() throws IOException {
    try (PdfDocument document = PdfDocument.open(CHECKBOX_FORM)) {
      PdfPage page = document.page(0);
      PdfFormField box = page.formFields().stream()
          .filter(PdfFormField::isToggle).findFirst().orElseThrow();

      page.setFieldChecked(box.index(), true);
      assertTrue(page.formFields().get(box.index()).checked());

      page.setFieldChecked(box.index(), false);
      assertFalse(page.formFields().get(box.index()).checked());
    }
  }

  @Test
  void aPageWithNoFieldsHasNoFields() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      assertEquals(List.of(), document.page(0).formFields());
    }
  }
}
