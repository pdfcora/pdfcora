package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;

/** DOCX files open by being converted to PDF first; everything after that is the PDF path. */
class DocxTest {
  private static final Path DOCX =
      Path.of(System.getProperty("pdfcora.conformance")).resolve("fixtures/docx");
  private static final Path HELLO = DOCX.resolve("hello.docx");

  private static void assertHello(PdfDocument document) {
    assertEquals(2, document.pageCount());
    assertTrue(document.page(0).text().contains("Hello DOCX"));
    assertTrue(document.page(1).text().contains("Second page"));
  }

  private static PdfError openFails(String name) {
    PdfError error = assertThrows(PdfError.class, () -> PdfDocument.open(DOCX.resolve(name)));
    assertEquals(PdfError.Code.CORRUPT, error.code());
    return error;
  }

  @Test
  void opensDocx() throws IOException {
    try (PdfDocument document = PdfDocument.open(HELLO)) {
      assertHello(document);
      assertNotNull(document.page(0).render(800));
    }
  }

  @Test
  void opensDocxFromBytes() throws IOException {
    try (PdfDocument document = PdfDocument.open(Files.readAllBytes(HELLO))) {
      assertHello(document);
    }
  }

  @Test
  void opensEmptyDocx() throws IOException {
    try (PdfDocument document = PdfDocument.open(DOCX.resolve("empty.docx"))) {
      assertEquals(1, document.pageCount());
    }
  }

  @Test
  void ignoresPasswordForDocx() throws IOException {
    try (PdfDocument document = PdfDocument.open(HELLO, "secret")) {
      assertEquals(2, document.pageCount());
    }
  }

  @Test
  void savesConvertedDocumentAsPdf() throws IOException {
    byte[] saved;
    try (PdfDocument document = PdfDocument.open(HELLO)) {
      saved = document.toByteArray();
    }
    assertEquals("%PDF-", new String(saved, 0, 5, java.nio.charset.StandardCharsets.US_ASCII));
    try (PdfDocument reopened = PdfDocument.open(saved)) {
      assertEquals(2, reopened.pageCount());
    }
  }

  @Test
  void opensDocxFromManyThreadsAtOnce() throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(8);
    try {
      List<Future<Integer>> counts = new ArrayList<>();
      for (int i = 0; i < 8; i++) {
        counts.add(pool.submit(() -> {
          try (PdfDocument document = PdfDocument.open(HELLO)) {
            return document.pageCount();
          }
        }));
      }
      for (Future<Integer> count : counts) assertEquals(2, count.get());
    } finally {
      pool.shutdown();
    }
  }

  @Test
  void notDocxZipFailsAsCorrupt() {
    openFails("not-docx.zip");
  }

  @Test
  void truncatedDocxFailsAsCorrupt() {
    String message = openFails("truncated.docx").getMessage();
    assertTrue(message.startsWith("the DOCX could not be converted: "), message);
  }

  @Test
  void encryptedDocxFailsWithMessage() {
    assertEquals("encrypted DOCX is not supported", openFails("encrypted.docx").getMessage());
  }

  @Test
  void legacyDocFailsAsCorrupt() {
    assertFalse(openFails("legacy.doc").getMessage().contains("encrypted"));
  }
}
