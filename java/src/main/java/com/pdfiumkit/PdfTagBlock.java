package com.pdfiumkit;

import java.util.List;

/**
 * One block of page content and the tag it should carry.
 *
 * `objectIndices` are positions in the page's drawing objects, which
 * {@link PdfDocument#objectCount(int)} counts. Blocks are given in reading order;
 * anything in no block becomes an artifact.
 */
public record PdfTagBlock(int pageIndex, String type, List<Integer> objectIndices, String altText) {
  public PdfTagBlock(int pageIndex, String type, List<Integer> objectIndices) {
    this(pageIndex, type, objectIndices, null);
  }

  /** The tags this SDK writes: headings, paragraphs, list items, figures and artifacts. */
  public static final List<String> TYPES =
      List.of("H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "Figure", "Artifact");
}
