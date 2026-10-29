package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Mirrors web/test/xfdf-import.test.ts and the iOS and Android import tests. */
class XfdfImportTest {
  private static final Path CONFORMANCE = Path.of(System.getProperty("pdfcora.conformance"));

  private static String text(String path) throws IOException {
    return Files.readString(CONFORMANCE.resolve(path), StandardCharsets.UTF_8);
  }

  private static PdfDocument blank() throws IOException {
    return PdfDocument.open(CONFORMANCE.resolve("xfdf/source-blank.pdf"));
  }

  private static void assertInvalid(Runnable call) {
    PdfError e = assertThrows(PdfError.class, call::run);
    assertEquals(PdfError.Code.INVALID_OPERATION, e.code());
  }

  /** The skipped list of expected-import.json, parsed with the same pattern for each entry. */
  private static List<PdfXfdfSkip> expectedSkipped(String json) {
    List<PdfXfdfSkip> out = new ArrayList<>();
    var entry = java.util.regex.Pattern.compile(
        "\\{\\s*\"element\":\\s*\"(\\w+)\",\\s*(?:\"page\":\\s*(\\d+),\\s*)?\"reason\":\\s*\"(\\w+)\"\\s*\\}").matcher(json);
    while (entry.find()) {
      out.add(new PdfXfdfSkip(entry.group(1), entry.group(2) == null ? null : Integer.valueOf(entry.group(2)),
          PdfXfdfSkip.Reason.fromWire(entry.group(3))));
    }
    return out;
  }

  @Test
  void importsConformanceFile() throws IOException {
    String json = text("xfdf/expected-import.json");
    try (PdfDocument document = blank()) {
      PdfXfdfReport report = document.importXfdf(text("xfdf/import.xfdf"));
      assertEquals(5, report.fieldsSet());
      assertEquals(5, report.annotationsAdded());
      assertEquals(expectedSkipped(json), report.skipped());
      assertTrue(json.contains("\"fieldsSet\": 5") && json.contains("\"annotationsAdded\": 5"));
    }
  }

  @Test
  void exportsWhatWasImported() throws IOException {
    try (PdfDocument document = blank()) {
      document.importXfdf(text("xfdf/import.xfdf"));
      assertEquals(text("xfdf/expected-after-import.xfdf"), document.exportXfdf());
    }
  }

  @Test
  void rejectsDoctype() throws IOException {
    try (PdfDocument document = blank()) {
      String before = document.exportXfdf();
      String doctype = text("xfdf/doctype.xfdf");
      assertInvalid(() -> document.importXfdf(doctype));
      assertEquals(before, document.exportXfdf());
    }
  }

  @Test
  void rejectsMalformed() throws IOException {
    try (PdfDocument document = blank()) {
      String before = document.exportXfdf();
      String malformed = text("xfdf/malformed.xfdf");
      assertInvalid(() -> document.importXfdf(malformed));
      assertInvalid(() -> document.importXfdf("<notxfdf/>"));
      assertEquals(before, document.exportXfdf());
    }
  }

  @Test
  void rejectsOversizedInput() throws IOException {
    try (PdfDocument document = blank()) {
      assertInvalid(() -> document.importXfdf("a".repeat(10_485_761)));
    }
  }

  @Test
  void importingTwiceAddsTwice() throws IOException {
    try (PdfDocument document = blank()) {
      String xfdf = text("xfdf/import.xfdf");
      assertEquals(5, document.importXfdf(xfdf).annotationsAdded());
      assertEquals(5, document.importXfdf(xfdf).annotationsAdded());
      assertEquals(2, document.page(0).annotations().stream().filter(a -> a.kind() == PdfAnnotation.Kind.INK).count());
    }
  }

  @Test
  void savedDocumentKeepsAuthorAndDates() throws IOException {
    byte[] saved;
    try (PdfDocument document = blank()) {
      document.importXfdf(text("xfdf/import.xfdf"));
      saved = document.toByteArray();
    }
    try (PdfDocument reopened = PdfDocument.open(saved)) {
      String xfdf = reopened.exportXfdf();
      assertTrue(xfdf.contains("title=\"Imported &amp; signed\""));
      assertTrue(xfdf.contains("date=\"D:20261030100000Z\""));
      assertTrue(xfdf.contains("name=\"imp-ink\""));
    }
  }
}
