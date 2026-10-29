package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** Mirrors web/test/xfdf-export.test.ts and the iOS and Android export tests. */
class XfdfExportTest {
  private static final Path CONFORMANCE = Path.of(System.getProperty("pdfcora.conformance"));

  private static String text(String path) throws IOException {
    return Files.readString(CONFORMANCE.resolve(path), StandardCharsets.UTF_8);
  }

  @Test
  void exportsConformanceDocumentExactly() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONFORMANCE.resolve("xfdf/source.pdf"))) {
      assertEquals(text("xfdf/expected-export.xfdf"), document.exportXfdf());
    }
  }

  @Test
  void exportEscapesAndKeepsUnicode() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONFORMANCE.resolve("xfdf/source.pdf"))) {
      String xfdf = document.exportXfdf();
      assertTrue(xfdf.contains("<value>Zoë &amp; \"Co\" &lt;ok&gt;</value>"));
      assertTrue(xfdf.contains("title=\"Zoë &amp; &quot;Co&quot; &lt;ok&gt;\""));
      assertTrue(xfdf.contains("<contents>A note &amp; a &lt;tag&gt;</contents>"));
    }
  }

  @Test
  void exportsEmptyDocument() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONFORMANCE.resolve("corpus/hello_world.pdf"))) {
      assertEquals("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">\n</xfdf>\n",
          document.exportXfdf());
    }
  }

  @Test
  void formatsNumbers() {
    assertEquals("1.2346", XfdfXml.format(1.23456));
    assertEquals("2.5", XfdfXml.format(2.5));
    assertEquals("0", XfdfXml.format(-0.0));
    assertEquals("0", XfdfXml.format(-0.00001));
    assertEquals("72", XfdfXml.format(72));
    assertEquals("72.0313", XfdfXml.format(72.03125));
    assertEquals("-72.0313", XfdfXml.format(-72.03125));
  }

  @Test
  void parserRejectsDoctype() {
    PdfError e = assertThrows(PdfError.class,
        () -> XfdfXml.parse("<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><x>&e;</x>"));
    assertEquals(PdfError.Code.INVALID_OPERATION, e.code());
    assertThrows(PdfError.class, () -> XfdfXml.parse("<x>&nbsp;</x>"));
    assertThrows(PdfError.class, () -> XfdfXml.parse("<x><y></x>"));
    XfdfXml.Element root = XfdfXml.parse("<a x=\"1&amp;2\"><b>t&lt;&#233;</b></a>");
    assertEquals("1&2", root.attributes().get("x"));
    assertEquals("t<é", root.children().get(0).text());
  }
}
