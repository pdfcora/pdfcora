package com.pdfiumkit;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Redaction is judged on the saved bytes, not on what the page reports: covering text is
 * the classic failure, and only the file says whether the words are gone.
 */
class PdfRedactionTest {
  private static final Path PII =
      Path.of(System.getProperty("pdfiumkit.conformance")).resolve("redaction/pii.pdf");

  private static boolean bytesContain(byte[] pdf, String needle) {
    // Uncompressed streams in this fixture, so a byte search is meaningful.
    String latin1 = new String(pdf, StandardCharsets.ISO_8859_1);
    return latin1.contains(needle);
  }

  @Test
  void removesEveryMatchOfAPhraseFromTheSavedBytes() throws IOException {
    byte[] saved;
    try (PdfDocument document = PdfDocument.open(PII)) {
      assertTrue(document.page(0).text().contains("anna.schmidt@example.com"));

      PdfRedaction.Report report = document.redact(
          List.of(new PdfRedaction.Target.TextMatches("anna.schmidt@example.com")));

      assertTrue(report.changedAnything());
      assertFalse(report.pages().isEmpty());
      assertFalse(document.page(0).text().contains("anna.schmidt@example.com"),
          "gone from the text layer");
      saved = document.toByteArray();
    }
    try (PdfDocument reopened = PdfDocument.open(saved)) {
      assertFalse(reopened.page(0).text().contains("anna.schmidt@example.com"),
          "gone after a save and reopen");
    }
    assertFalse(bytesContain(saved, "anna.schmidt@example.com"), "gone from the file itself");
  }

  @Test
  void leavesTheRestOfThePageLegible() throws IOException {
    try (PdfDocument document = PdfDocument.open(PII)) {
      String before = document.page(0).text();
      int lengthBefore = before.length();

      document.redact(List.of(new PdfRedaction.Target.TextMatches("anna.schmidt@example.com")));
      String after = document.page(0).text();

      assertTrue(after.length() < lengthBefore, "something was removed");
      assertTrue(after.length() > lengthBefore / 2,
          "only the match was removed, not the whole page: " + after.length() + " of " + lengthBefore);
      // A neighbouring value on the same page survives.
      assertTrue(before.contains("GB29") == after.contains("GB29"));
    }
  }

  @Test
  void aRegionRemovesWhatItCovers() throws IOException {
    try (PdfDocument document = PdfDocument.open(PII)) {
      PdfPage page = document.page(0);
      PdfPage.Size size = page.size();
      int lengthBefore = page.text().length();

      // The whole top half of the page.
      PdfRedaction.Report report = document.redact(List.of(new PdfRedaction.Target.Region(
          0, new PdfAnnotation.Rect(0, size.height() / 2, size.width(), size.height()))));

      assertTrue(report.changedAnything());
      assertTrue(page.text().length() < lengthBefore);
    }
  }

  @Test
  void aPhraseThatIsNotThereChangesNothing() throws IOException {
    try (PdfDocument document = PdfDocument.open(PII)) {
      int before = document.page(0).text().length();
      PdfRedaction.Report report = document.redact(
          List.of(new PdfRedaction.Target.TextMatches("nothing-like-this-is-in-the-file")));

      assertFalse(report.changedAnything());
      assertEquals(List.of(), report.pages());
      assertEquals(before, document.page(0).text().length());
    }
  }
}
