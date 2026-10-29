package com.pdfcora;

import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NamedNodeMap;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;

/** The XML side of XFDF: an element tree, the canonical number format and escaping. */
final class XfdfXml {
  static final int MAX_BYTES = 10 * 1024 * 1024;

  private XfdfXml() {}

  /** One element: its attributes, child elements and the text directly inside it. */
  record Element(String name, Map<String, String> attributes, List<Element> children, String text) {}

  private static PdfError invalid(String why) {
    return new PdfError(PdfError.Code.INVALID_OPERATION, "not valid XFDF: " + why);
  }

  /**
   * Parses XFDF with the JDK's DOM parser. Input from outside is untrusted, so DOCTYPEs are
   * disallowed outright, external entities and XInclude are off, and secure processing is on.
   */
  static Element parse(String text) {
    if (text.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw invalid("larger than 10 MiB");
    if (text.contains("<!DOCTYPE") || text.contains("<!ENTITY")) {
      throw invalid("DOCTYPE and entity declarations are not allowed");
    }
    try {
      DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
      factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
      factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
      factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
      factory.setXIncludeAware(false);
      factory.setExpandEntityReferences(false);
      factory.setNamespaceAware(false);
      var builder = factory.newDocumentBuilder();
      builder.setErrorHandler(null);
      return convert(builder.parse(new InputSource(new StringReader(text))).getDocumentElement());
    } catch (PdfError e) {
      throw e;
    } catch (Exception e) {
      throw invalid(e.getMessage() == null ? "malformed XML" : e.getMessage());
    }
  }

  private static Element convert(org.w3c.dom.Element node) {
    Map<String, String> attributes = new LinkedHashMap<>();
    NamedNodeMap map = node.getAttributes();
    for (int i = 0; i < map.getLength(); i++) attributes.put(map.item(i).getNodeName(), map.item(i).getNodeValue());
    List<Element> children = new ArrayList<>();
    StringBuilder text = new StringBuilder();
    for (Node child = node.getFirstChild(); child != null; child = child.getNextSibling()) {
      switch (child.getNodeType()) {
        case Node.ELEMENT_NODE -> children.add(convert((org.w3c.dom.Element) child));
        case Node.TEXT_NODE, Node.CDATA_SECTION_NODE -> text.append(child.getNodeValue());
        case Node.ENTITY_REFERENCE_NODE -> throw invalid("unknown entity &" + child.getNodeName() + ";");
        default -> { }
      }
    }
    return new Element(node.getTagName(), attributes, children, text.toString());
  }

  /** At most four decimals, no trailing zeros, no exponent, and never "-0". */
  static String format(double value) {
    String text = String.format(Locale.ROOT, "%.4f", value);
    text = text.replaceAll("0+$", "").replaceAll("\\.$", "");
    return text.equals("-0") ? "0" : text;
  }

  static String escapeAttribute(String s) {
    StringBuilder out = new StringBuilder(s.length());
    for (char c : s.toCharArray()) {
      switch (c) {
        case '&' -> out.append("&amp;");
        case '<' -> out.append("&lt;");
        case '>' -> out.append("&gt;");
        case '"' -> out.append("&quot;");
        case '\'' -> out.append("&apos;");
        default -> out.append(c);
      }
    }
    return out.toString();
  }

  static String escapeText(String s) {
    StringBuilder out = new StringBuilder(s.length());
    for (char c : s.toCharArray()) {
      switch (c) {
        case '&' -> out.append("&amp;");
        case '<' -> out.append("&lt;");
        case '>' -> out.append("&gt;");
        default -> out.append(c);
      }
    }
    return out.toString();
  }
}
