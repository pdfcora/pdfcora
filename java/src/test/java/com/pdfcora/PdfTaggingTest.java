package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.Inflater;
import org.junit.jupiter.api.Test;

/**
 * Tagging an untagged document. The fixture is the one every platform is tested against,
 * and CI runs veraPDF over the file this writes.
 */
class PdfTaggingTest {
  private static final Path UNTAGGED =
      Path.of(System.getProperty("pdfcora.conformance")).resolve("remediation/untagged.pdf");

  /**
   * PDFium re-saves the document when its bytes are asked for, and writes /Lang(en)
   * where this writer wrote /Lang (en) — both are valid PDF. Assertions therefore allow
   * either spacing, as a real parser would.
   */
  private static boolean has(String file, String pattern) {
    return Pattern.compile(pattern).matcher(file).find();
  }

  /**
   * Marked content lives inside the page's content stream, which PDFium compresses, so
   * a byte search cannot see it. This inflates every Flate stream in the file.
   */
  private static String inflatedStreams(byte[] pdf) throws IOException {
    String file = new String(pdf, StandardCharsets.ISO_8859_1);
    StringBuilder out = new StringBuilder();
    Matcher stream = Pattern.compile("/Filter\\s*/FlateDecode.*?stream\\r?\\n", Pattern.DOTALL).matcher(file);
    while (stream.find()) {
      int start = stream.end();
      int end = file.indexOf("endstream", start);
      if (end < 0) continue;
      byte[] data = new byte[end - start];
      System.arraycopy(pdf, start, data, 0, data.length);
      Inflater inflater = new Inflater();
      inflater.setInput(data);
      byte[] buffer = new byte[64 * 1024];
      try {
        int n = inflater.inflate(buffer);
        out.append(new String(buffer, 0, n, StandardCharsets.ISO_8859_1));
      } catch (Exception ignored) {
        // Not every Flate stream in a file is one this test can read; skip it.
      } finally {
        inflater.end();
      }
    }
    return out.toString();
  }

  /** One block per object, in object order, which is enough to exercise the writer. */
  private static List<PdfTagBlock> blocksFor(PdfDocument document) {
    List<PdfTagBlock> blocks = new ArrayList<>();
    for (int page = 0; page < document.pageCount(); page++) {
      int objects = document.objectCount(page);
      for (int object = 0; object < objects; object++) {
        String type = object == 0 && page == 0 ? "H1" : "P";
        blocks.add(new PdfTagBlock(page, type, List.of(object)));
      }
    }
    return blocks;
  }

  @Test
  void anUntaggedDocumentBecomesTagged() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      assertFalse(document.isTagged());

      try (PdfDocument tagged = document.tagContent(blocksFor(document), "Quarterly newsletter", "en")) {
        assertTrue(tagged.isTagged(), "the result carries a structure tree");
        assertFalse(document.isTagged(), "the original is untouched");
        assertEquals(document.pageCount(), tagged.pageCount());
        assertFalse(tagged.page(0).text().isEmpty(), "the content survived marking");
      }
    }
  }

  @Test
  void theTaggedFileDeclaresPdfUaAndItsTitle() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      PdfDocument tagged = document.tagContent(blocksFor(document), "Quarterly newsletter", "en-GB");
      String file = new String(tagged.toByteArray(), StandardCharsets.ISO_8859_1);
      tagged.close();

      assertTrue(file.contains("/StructTreeRoot"), "a structure tree root");
      assertTrue(file.contains("/ParentTree"), "a parent tree, or a reader cannot map ids back");
      assertTrue(file.contains("/MarkInfo"), "marked-content is declared");
      assertTrue(file.contains("/StructParents"), "each page names its parent-tree slot");
      assertTrue(file.contains("pdfuaid:part"), "the XMP packet claims PDF/UA");
      assertTrue(file.contains("Quarterly newsletter"), "the title a reader announces");
      assertTrue(has(file, "/Lang\\s*\\(en-GB\\)"));
      // Every object is in a block here, so there is nothing left to be an artifact;
      // the artifact path is covered where blocks leave objects out.
    }
  }

  @Test
  void listItemsAreGroupedIntoOneList() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      List<PdfTagBlock> blocks = new ArrayList<>();
      blocks.add(new PdfTagBlock(0, "H1", List.of(0)));
      for (int object = 1; object < Math.min(4, document.objectCount(0)); object++) {
        blocks.add(new PdfTagBlock(0, "LI", List.of(object)));
      }

      PdfDocument tagged = document.tagContent(blocks, "Lists", "en");
      String file = new String(tagged.toByteArray(), StandardCharsets.ISO_8859_1);
      tagged.close();

      assertTrue(has(file, "/S\\s*/L\\b"), "consecutive items share one list");
      assertTrue(has(file, "/S\\s*/LI\\b"), "each item is an LI");
      assertTrue(has(file, "/S\\s*/LBody\\b"), "whose content is an LBody");
    }
  }

  @Test
  void aFigureCarriesItsAlternateText() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      List<PdfTagBlock> blocks = List.of(
          new PdfTagBlock(0, "H1", List.of(0)),
          new PdfTagBlock(0, "Figure", List.of(1), "The Berlin office at dusk"));

      PdfDocument tagged = document.tagContent(blocks, "Figures", "en");
      String file = new String(tagged.toByteArray(), StandardCharsets.ISO_8859_1);
      tagged.close();

      assertTrue(has(file, "/S\\s*/Figure\\b"));
      assertTrue(has(file, "/Alt\\s*\\(The Berlin office at dusk\\)"),
          "a figure without alternate text is the most common PDF/UA failure");
    }
  }

  @Test
  void objectsInNoBlockBecomeArtifacts() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      // Only the first object is tagged; everything else is content a reader must skip.
      PdfDocument tagged = document.tagContent(
          List.of(new PdfTagBlock(0, "H1", List.of(0))), "Artifacts", "en");
      byte[] bytes = tagged.toByteArray();
      tagged.close();

      String content = inflatedStreams(bytes);
      assertTrue(content.contains("/Artifact"), "untagged content is marked as an artifact");
      assertTrue(content.contains("/H1"), "and the tagged block keeps its tag");
    }
  }

  @Test
  void theResultIsWrittenForVeraPdfToJudge() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      List<PdfTagBlock> blocks = new ArrayList<>();
      for (int page = 0; page < document.pageCount(); page++) {
        for (int object = 0; object < document.objectCount(page); object++) {
          blocks.add(new PdfTagBlock(page, page == 0 && object == 0 ? "H1" : "P", List.of(object)));
        }
      }
      PdfDocument tagged = document.tagContent(blocks, "Quarterly newsletter", "en");
      Path out = Path.of(System.getProperty("pdfcora.conformance")).getParent()
          .resolve("build/remediation");
      Files.createDirectories(out);
      tagged.writeTo(out.resolve("written-java.pdf"));
      tagged.close();
      assertTrue(Files.size(out.resolve("written-java.pdf")) > 0);
    }
  }

  @Test
  void taggingRefusesWhatItCannotDo() throws IOException {
    try (PdfDocument document = PdfDocument.open(UNTAGGED)) {
      assertEquals(PdfError.Code.INVALID_OPERATION, assertThrows(PdfError.class,
          () -> document.tagContent(blocksFor(document), "  ", "en")).code(), "no title");

      assertEquals(PdfError.Code.INVALID_OPERATION, assertThrows(PdfError.class,
          () -> document.tagContent(List.of(new PdfTagBlock(0, "P", List.of(999))), "T", "en")).code(),
          "an object that is not on the page");

      assertEquals(PdfError.Code.INVALID_OPERATION, assertThrows(PdfError.class,
          () -> document.tagContent(List.of(
              new PdfTagBlock(0, "P", List.of(0)), new PdfTagBlock(0, "H1", List.of(0))), "T", "en")).code(),
          "the same object in two blocks");

      PdfDocument tagged = document.tagContent(blocksFor(document), "Once", "en");
      assertEquals(PdfError.Code.INVALID_OPERATION,
          assertThrows(PdfError.class, () -> tagged.tagContent(List.of(), "Twice", "en")).code(),
          "a tagged document is not tagged again");
      tagged.close();
    }
  }
}
