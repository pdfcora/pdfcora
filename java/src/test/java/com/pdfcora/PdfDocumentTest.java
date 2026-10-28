package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.ArrayList;
import org.junit.jupiter.api.Test;

/** Mirrors the core suites on iOS, Android and the web, against the same fixtures. */
class PdfDocumentTest {
  private static final Path CONFORMANCE = Path.of(System.getProperty("pdfcora.conformance"));
  private static final Path CONTRACT = CONFORMANCE.resolve("fixtures/contract.pdf");
  private static final Path ENCRYPTED = CONFORMANCE.resolve("corpus/encrypted_hello_world_r2.pdf");

  private static PdfDocument contract() throws IOException {
    return PdfDocument.open(CONTRACT);
  }

  @Test
  void opensAndCountsPages() throws IOException {
    try (PdfDocument document = contract()) {
      assertEquals(3, document.pageCount());
      assertFalse(document.isClosed());
    }
  }

  @Test
  void readsPageTextInReadingOrder() throws IOException {
    try (PdfDocument document = contract()) {
      String text = document.page(0).text();
      assertTrue(text.contains("Parties"), text.substring(0, Math.min(80, text.length())));
      assertTrue(text.contains("Annex A"));
      // The same count every other platform asserts for this page.
      assertEquals(323, document.page(0).characterCount());
    }
  }

  @Test
  void searchesWithOffsetsAndLengths() throws IOException {
    try (PdfDocument document = contract()) {
      List<PdfPage.Match> matches = document.page(0).search("the");
      assertFalse(matches.isEmpty());
      String text = document.page(0).text();
      for (PdfPage.Match match : matches) {
        assertEquals("the", text.substring(match.start(), match.start() + match.length()).toLowerCase());
      }
      assertTrue(document.page(0).search("Supplier", true).size() > 0);
      assertEquals(List.of(), document.page(0).search(""));
    }
  }

  @Test
  void rendersAtTheRequestedWidthKeepingTheAspectRatio() throws IOException {
    try (PdfDocument document = contract()) {
      PdfPage page = document.page(0);
      PdfPage.Size size = page.size();
      assertTrue(size.width() > 0 && size.height() > 0);

      BufferedImage image = page.render(400);
      assertEquals(400, image.getWidth());
      assertEquals(Math.round(400 * size.height() / size.width()), image.getHeight());
      // A rendered page is not blank: the text is dark on white.
      boolean anyDark = false;
      for (int y = 0; y < image.getHeight() && !anyDark; y += 4) {
        for (int x = 0; x < image.getWidth(); x += 4) {
          if ((image.getRGB(x, y) & 0xFF) < 128) { anyDark = true; break; }
        }
      }
      assertTrue(anyDark, "the rendered page has no dark pixels");
    }
  }

  @Test
  void readsMetadataAndPermissions() throws IOException {
    try (PdfDocument document = contract()) {
      Map<String, String> metadata = document.metadata();
      assertNotNull(metadata);
      assertNotEquals(0, document.permissions());
    }
  }

  @Test
  void savesAndTheResultReopens() throws IOException {
    try (PdfDocument document = contract()) {
      byte[] bytes = document.toByteArray();
      assertTrue(bytes.length > 0);
      try (PdfDocument reopened = PdfDocument.open(bytes)) {
        assertEquals(3, reopened.pageCount());
      }
      Path out = Files.createTempFile("pdfcora", ".pdf");
      document.writeTo(out);
      assertEquals(bytes.length, Files.size(out));
      Files.deleteIfExists(out);
    }
  }

  @Test
  void anEncryptedDocumentAsksForAPassword() {
    PdfError error = assertThrows(PdfError.class, () -> PdfDocument.open(ENCRYPTED));
    assertEquals(PdfError.Code.PASSWORD_REQUIRED, error.code());

    PdfError refused = assertThrows(PdfError.class, () -> PdfDocument.open(ENCRYPTED, "definitely-not-it"));
    assertEquals(PdfError.Code.WRONG_PASSWORD, refused.code());
  }

  @Test
  void aPageOutsideTheDocumentIsRefused() throws IOException {
    try (PdfDocument document = contract()) {
      assertEquals(PdfError.Code.PAGE_OUT_OF_RANGE,
          assertThrows(PdfError.class, () -> document.page(99)).code());
      assertEquals(PdfError.Code.PAGE_OUT_OF_RANGE,
          assertThrows(PdfError.class, () -> document.page(-1)).code());
    }
  }

  @Test
  void usingAClosedDocumentRaisesRatherThanCrashing() throws IOException {
    PdfDocument document = contract();
    PdfPage page = document.page(0);
    document.close();

    assertTrue(document.isClosed());
    assertEquals(PdfError.Code.CLOSED, assertThrows(PdfError.class, document::pageCount).code());
    assertEquals(PdfError.Code.CLOSED, assertThrows(PdfError.class, page::text).code());
    // Closing twice is harmless, which matters for try-with-resources.
    document.close();
  }

  @Test
  void manyThreadsCanUseOneDocument() throws Exception {
    try (PdfDocument document = contract()) {
      // What matters is that concurrent calls serialise: every thread must see the same
      // text for the same page. The third page of this fixture is deliberately empty,
      // so the assertion is agreement, not a non-zero length.
      int[] expected = { document.page(0).text().length(), document.page(1).text().length(),
                         document.page(2).text().length() };

      ExecutorService pool = Executors.newFixedThreadPool(8);
      List<Callable<int[]>> work = new ArrayList<>();
      for (int i = 0; i < 64; i++) {
        final int page = i % 3;
        work.add(() -> new int[] { page, document.page(page).text().length() });
      }
      for (Future<int[]> result : pool.invokeAll(work)) {
        int[] seen = result.get();
        assertEquals(expected[seen[0]], seen[1], "page " + seen[0] + " read differently from another thread");
      }
      pool.shutdown();
      assertTrue(expected[0] > 0 && expected[1] > 0);
    }
  }

  @Test
  void separateDocumentsCanBeUsedFromSeparateThreadsAtOnce() throws Exception {
    // PDFium's global state is shared by every document, so this crashed the JVM when each
    // document had its own engine thread.
    String[] files = { "hello_world.pdf", "text_form.pdf", "rectangles.pdf",
                       "many_rectangles.pdf", "text_font.pdf", "find_text_consecutive.pdf" };
    ExecutorService pool = Executors.newFixedThreadPool(files.length);
    try {
      for (int round = 0; round < 50; round++) {
        List<Future<Integer>> results = new ArrayList<>();
        for (String name : files) {
          byte[] bytes = Files.readAllBytes(CONFORMANCE.resolve("corpus").resolve(name));
          results.add(pool.submit(() -> {
            try (PdfDocument document = PdfDocument.open(bytes)) {
              PdfPage page = document.page(0);
              page.search("e");
              page.render(120);
              return page.text().length();
            }
          }));
        }
        for (Future<Integer> result : results) assertTrue(result.get() >= 0);
      }
    } finally {
      pool.shutdown();
    }
  }
}
