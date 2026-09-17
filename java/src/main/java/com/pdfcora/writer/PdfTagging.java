package com.pdfcora.writer;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Writing a structure tree for content PDFium has already marked.
 *
 * PDFium puts marked-content ids into the page content; the tree that points at them is
 * dictionaries, which only this writer can create. The result claims PDF/UA-1, and
 * veraPDF is what decides whether the claim is true.
 */
public final class PdfTagging {
  private PdfTagging() {}

  /** One tagged block: a tag, the page it is on, and the ids PDFium gave its objects. */
  public record Block(int pageIndex, String type, List<Integer> mcids, String altText) {
    public Block(int pageIndex, String type, List<Integer> mcids) {
      this(pageIndex, type, mcids, null);
    }
  }

  /**
   * Appends the tree to `bytes`.
   *
   * @param mcidCounts how many ids each page used, so the parent tree has a slot per id
   */
  public static byte[] write(byte[] bytes, List<Block> blocks, List<Integer> mcidCounts,
                             String title, String language) {
    PdfTrailer trailer = PdfTrailer.scan(bytes);
    PdfObjects objects = new PdfObjects(bytes);
    int catalogNumber = objects.catalogNumber(trailer);
    List<Integer> pages = objects.pages(catalogNumber);

    int[] next = { trailer.nextObjectNumber() };
    int rootNumber = next[0]++;
    int documentNumber = next[0]++;
    int metadataNumber = next[0]++;

    Map<Integer, PdfValue> out = new LinkedHashMap<>();
    List<String> documentKids = new ArrayList<>();
    // One slot per marked-content id per page, filled with the element that owns it.
    List<String[]> parents = new ArrayList<>();
    for (int count : mcidCounts) parents.add(new String[count]);

    Integer listNumber = null;
    List<String> listKids = new ArrayList<>();

    for (Block block : blocks) {
      int page = pages.get(block.pageIndex());
      int holder = next[0]++;
      StringBuilder kids = new StringBuilder();
      for (int id : block.mcids()) {
        kids.append(kids.length() == 0 ? "" : " ").append(id);
        if (id < parents.get(block.pageIndex()).length) parents.get(block.pageIndex())[id] = holder + " 0 R";
      }
      String content = "/Pg " + page + " 0 R /K [" + kids + "]";

      if (!block.type().equals("LI")) {
        if (listNumber != null) { out.put(listNumber, listElement(listNumber, documentNumber, listKids)); }
        listNumber = null;
        listKids = new ArrayList<>();
        String alt = block.altText() == null ? "" : " /Alt (" + escape(block.altText()) + ")";
        out.put(holder, raw("<< /Type /StructElem /S /" + block.type()
            + " /P " + documentNumber + " 0 R " + content + alt + " >>"));
        documentKids.add(holder + " 0 R");
        continue;
      }

      // Consecutive list items share one /L, each an /LI holding an /LBody.
      if (listNumber == null) {
        listNumber = next[0]++;
        listKids = new ArrayList<>();
        documentKids.add(listNumber + " 0 R");
      }
      int item = next[0]++;
      listKids.add(item + " 0 R");
      out.put(item, raw("<< /Type /StructElem /S /LI /P " + listNumber + " 0 R /K [" + holder + " 0 R] >>"));
      out.put(holder, raw("<< /Type /StructElem /S /LBody /P " + item + " 0 R " + content + " >>"));
    }
    if (listNumber != null) out.put(listNumber, listElement(listNumber, documentNumber, listKids));

    int parentTree = next[0]++;
    StringBuilder nums = new StringBuilder();
    for (int pageIndex = 0; pageIndex < parents.size(); pageIndex++) {
      nums.append(pageIndex).append(" [");
      String[] row = parents.get(pageIndex);
      for (int i = 0; i < row.length; i++) {
        nums.append(i == 0 ? "" : " ").append(row[i] == null ? "null" : row[i]);
      }
      nums.append("] ");
    }
    out.put(parentTree, raw("<< /Nums [" + nums.toString().trim() + "] >>"));

    StringBuilder kids = new StringBuilder();
    for (String kid : documentKids) kids.append(kids.length() == 0 ? "" : " ").append(kid);
    out.put(documentNumber, raw("<< /Type /StructElem /S /Document /P " + rootNumber
        + " 0 R /K [" + kids + "] >>"));
    out.put(rootNumber, raw("<< /Type /StructTreeRoot /K " + documentNumber + " 0 R /ParentTree "
        + parentTree + " 0 R /ParentTreeNextKey " + pages.size() + " >>"));

    // Each page says which parent-tree slot is its own, and that its tab order follows
    // the structure.
    for (int pageIndex = 0; pageIndex < pages.size(); pageIndex++) {
      out.put(pages.get(pageIndex),
          objects.merged(pages.get(pageIndex), "/StructParents " + pageIndex + " /Tabs /S "));
    }

    byte[] xmp = xmpPacket(title).getBytes(StandardCharsets.UTF_8);
    byte[] head = PdfValue.ascii("<< /Type /Metadata /Subtype /XML /Length " + xmp.length + " >>\nstream\n");
    byte[] tail = PdfValue.ascii("\nendstream");
    byte[] metadata = new byte[head.length + xmp.length + tail.length];
    System.arraycopy(head, 0, metadata, 0, head.length);
    System.arraycopy(xmp, 0, metadata, head.length, xmp.length);
    System.arraycopy(tail, 0, metadata, head.length + xmp.length, tail.length);
    out.put(metadataNumber, new PdfValue.Raw(metadata));

    String catalogAdditions = "/StructTreeRoot " + rootNumber + " 0 R /MarkInfo << /Marked true >> "
        + "/Metadata " + metadataNumber + " 0 R /ViewerPreferences << /DisplayDocTitle true >> "
        + (language == null ? "" : "/Lang (" + escape(language) + ") ");
    out.put(catalogNumber, objects.merged(catalogNumber, catalogAdditions));

    return PdfAppend.append(bytes, out, null);
  }

  private static PdfValue listElement(int number, int parent, List<String> kids) {
    StringBuilder items = new StringBuilder();
    for (String kid : kids) items.append(items.length() == 0 ? "" : " ").append(kid);
    return raw("<< /Type /StructElem /S /L /P " + parent + " 0 R /K [" + items + "] >>");
  }

  private static PdfValue raw(String dictionary) {
    return new PdfValue.Raw(PdfValue.ascii(dictionary));
  }

  private static String escape(String value) {
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)");
  }

  /** The packet that declares PDF/UA-1 and carries the title a reader announces. */
  private static String xmpPacket(String title) {
    return "<?xpacket begin=\"﻿\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n"
        + "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n"
        + "<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
        + "xmlns:pdfuaid=\"http://www.aiim.org/pdfua/ns/id/\">\n"
        + "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">" + xmlEscape(title) + "</rdf:li></rdf:Alt></dc:title>\n"
        + "<pdfuaid:part>1</pdfuaid:part>\n</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>";
  }

  private static String xmlEscape(String value) {
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
  }
}
