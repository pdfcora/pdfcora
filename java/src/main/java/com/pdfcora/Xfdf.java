package com.pdfcora;

import com.pdfcora.writer.PdfObjects;
import com.pdfcora.writer.PdfTrailer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** XFDF export and import, on top of the engine calls the public model does not expose. */
final class Xfdf {
  private Xfdf() {}

  private static final String[] FLAG_NAMES = { "invisible", "hidden", "print", "nozoom", "norotate", "noview",
      "readonly", "locked", "togglenoview", "lockedcontents" };
  private static final Map<PdfAnnotation.Kind, String> ELEMENT = Map.ofEntries(
      Map.entry(PdfAnnotation.Kind.HIGHLIGHT, "highlight"), Map.entry(PdfAnnotation.Kind.UNDERLINE, "underline"),
      Map.entry(PdfAnnotation.Kind.STRIKEOUT, "strikeout"), Map.entry(PdfAnnotation.Kind.SQUIGGLY, "squiggly"),
      Map.entry(PdfAnnotation.Kind.INK, "ink"), Map.entry(PdfAnnotation.Kind.TEXT, "text"),
      Map.entry(PdfAnnotation.Kind.SQUARE, "square"), Map.entry(PdfAnnotation.Kind.CIRCLE, "circle"),
      Map.entry(PdfAnnotation.Kind.LINE, "line"), Map.entry(PdfAnnotation.Kind.FREE_TEXT, "freetext"),
      Map.entry(PdfAnnotation.Kind.STAMP, "stamp"), Map.entry(PdfAnnotation.Kind.FILE_ATTACHMENT, "fileattachment"));
  private static final Set<String> SUPPORTED = Set.of("ink", "text", "highlight", "underline", "strikeout");

  private static String f(double v) { return XfdfXml.format(v); }
  private static String orNull(String s) { return s == null || s.isEmpty() ? null : s; }

  /** One widget as XFDF needs it: the public field plus its export value and options. */
  private record Widget(int page, PdfFormField field, String exportValue, List<String> options, List<Integer> selected) {}

  private static List<Widget> widgets(PdfDocument document) {
    List<Widget> out = new ArrayList<>();
    for (int p = 0; p < document.pageCount(); p++) {
      final int page = p;
      for (PdfFormField field : document.page(p).formFields()) {
        String[] choices = document.call(h -> Native.formFieldChoices(h, page, field.index()));
        List<String> options = new ArrayList<>();
        List<Integer> selected = new ArrayList<>();
        if (choices != null) {
          for (int i = 1; i < choices.length; i++) {
            options.add(choices[i].substring(1));
            if (choices[i].charAt(0) == '1') selected.add(i - 1);
          }
        }
        out.add(new Widget(page, field, choices == null ? null : orNull(choices[0]), options, selected));
      }
    }
    return out;
  }

  // ---- export ---------------------------------------------------------------------------

  private static final class FieldNode {
    final String name;
    List<String> values;
    final List<FieldNode> children = new ArrayList<>();
    FieldNode(String name) { this.name = name; }
  }

  private static List<String> values(List<Widget> widgets) {
    Widget first = widgets.get(0);
    switch (first.field().kind()) {
      case TEXT_FIELD:
      case COMBO_BOX:
        return first.field().value().isEmpty() ? null : List.of(first.field().value());
      case CHECK_BOX:
      case RADIO_BUTTON:
        for (Widget w : widgets) {
          if (w.field().checked()) return List.of(w.exportValue() == null ? "Yes" : w.exportValue());
        }
        return List.of("Off");
      case LIST_BOX: {
        List<String> chosen = new ArrayList<>();
        for (int i : first.selected()) chosen.add(first.options().get(i));
        return chosen.isEmpty() ? null : chosen;
      }
      default:
        return null;
    }
  }

  private static void writeFields(List<FieldNode> nodes, int depth, List<String> out) {
    String pad = "  ".repeat(depth);
    for (FieldNode node : nodes) {
      out.add(pad + "<field name=\"" + XfdfXml.escapeAttribute(node.name) + "\">");
      if (node.values != null) for (String v : node.values) out.add(pad + "  <value>" + XfdfXml.escapeText(v) + "</value>");
      writeFields(node.children, depth + 1, out);
      out.add(pad + "</field>");
    }
  }

  /**
   * Each annotation's /C, keyed "page:index", from a full save. PDFium's FPDFAnnot_GetColor
   * refuses once an annotation has an appearance stream, which PDFium generates for most
   * markup when a page is loaded; /Annots order is the index PDFium uses.
   */
  private static Map<String, int[]> annotationColors(PdfDocument document) {
    byte[] bytes = document.toByteArray();
    PdfObjects objects = new PdfObjects(bytes);
    List<Integer> pages = objects.pages(objects.catalogNumber(PdfTrailer.scan(bytes)));
    Map<String, int[]> colors = new HashMap<>();
    Pattern ref = Pattern.compile("(\\d+)\\s+\\d+\\s+R");
    for (int p = 0; p < pages.size(); p++) {
      String annots = PdfObjects.entryOf(objects.inner(pages.get(p)), "Annots");
      if (annots == null) continue;
      if (!annots.startsWith("[")) {
        Matcher indirect = ref.matcher(annots);
        if (!indirect.find()) continue;
        annots = objects.body(Integer.parseInt(indirect.group(1))).trim();
      }
      List<String> entries = arrayEntries(annots);
      for (int index = 0; index < entries.size(); index++) {
        String entry = entries.get(index);
        Matcher reference = ref.matcher(entry);
        String dictionary = entry.startsWith("<<")
            ? entry.substring(2, entry.length() - 2)
            : reference.matches() ? objects.inner(Integer.parseInt(reference.group(1))) : null;
        int[] color = dictionary == null ? null : colorOf(PdfObjects.entryOf(dictionary, "C"));
        if (color != null) colors.put(p + ":" + index, color);
      }
    }
    return colors;
  }

  /**
   * The entries of an /Annots array: references "N G R" or inline dictionaries, which is how
   * PDFium saves annotations created in this session.
   */
  private static List<String> arrayEntries(String array) {
    List<String> out = new ArrayList<>();
    String body = array.substring(array.indexOf('[') + 1, array.lastIndexOf(']'));
    Matcher reference = Pattern.compile("\\G\\s*(\\d+\\s+\\d+\\s+R)").matcher(body);
    int at = 0;
    while (at < body.length()) {
      while (at < body.length() && Character.isWhitespace(body.charAt(at))) at++;
      if (at >= body.length()) break;
      if (body.startsWith("<<", at)) {
        int depth = 0;
        int i = at;
        for (; i < body.length() - 1; i++) {
          char c = body.charAt(i);
          if (c == '(') {
            // A literal string may hold ">>" or "<<"; skip it, honouring escapes and nesting.
            int parens = 0;
            for (; i < body.length(); i++) {
              char d = body.charAt(i);
              if (d == '\\') { i++; continue; }
              if (d == '(') parens++;
              else if (d == ')' && --parens == 0) break;
            }
          } else if (body.startsWith("<<", i)) { depth++; i++; }
          else if (body.startsWith(">>", i)) { depth--; i++; if (depth == 0) break; }
          else if (c == '<') { int end = body.indexOf('>', i); if (end < 0) break; i = end; }
        }
        out.add(body.substring(at, i + 1));
        at = i + 1;
      } else if (reference.find(at)) {
        out.add(reference.group(1).trim());
        at = reference.end();
      } else {
        break;
      }
    }
    return out;
  }

  /** /C has 1 (grey), 3 (RGB) or 4 (CMYK) components; none means transparent. */
  private static int[] colorOf(String value) {
    if (value == null || !value.startsWith("[")) return null;
    String[] parts = value.substring(1, value.lastIndexOf(']')).trim().split("\\s+");
    if (parts.length == 1 && parts[0].isEmpty()) return null;
    double[] c = new double[parts.length];
    try {
      for (int i = 0; i < parts.length; i++) c[i] = Double.parseDouble(parts[i]);
    } catch (NumberFormatException e) {
      return null;
    }
    return switch (c.length) {
      case 1 -> new int[] { channel(c[0]), channel(c[0]), channel(c[0]) };
      case 3 -> new int[] { channel(c[0]), channel(c[1]), channel(c[2]) };
      case 4 -> new int[] { channel((1 - c[0]) * (1 - c[3])), channel((1 - c[1]) * (1 - c[3])), channel((1 - c[2]) * (1 - c[3])) };
      default -> null;
    };
  }

  private static int channel(double v) { return (int) Math.round(Math.min(1, Math.max(0, v)) * 255); }

  static String export(PdfDocument document) {
    Map<String, int[]> colors = null;
    Map<String, List<Widget>> byName = new LinkedHashMap<>();
    for (Widget w : widgets(document)) {
      if (w.field().name().isEmpty()) continue;
      byName.computeIfAbsent(w.field().name(), k -> new ArrayList<>()).add(w);
    }
    List<FieldNode> roots = new ArrayList<>();
    for (Map.Entry<String, List<Widget>> e : byName.entrySet()) {
      List<String> values = values(e.getValue());
      if (values == null) continue;
      List<FieldNode> level = roots;
      FieldNode node = null;
      for (String part : e.getKey().split("\\.", -1)) {
        node = null;
        for (FieldNode n : level) if (n.name.equals(part)) node = n;
        if (node == null) { node = new FieldNode(part); level.add(node); }
        level = node.children;
      }
      node.values = values;
    }

    List<String> annots = new ArrayList<>();
    for (int p = 0; p < document.pageCount(); p++) {
      final int page = p;
      for (PdfAnnotation a : document.page(p).annotations()) {
        String element = ELEMENT.get(a.kind());
        if (element == null) continue;
        // The save behind the colour lookup is only paid when there is something to export.
        if (colors == null) colors = annotationColors(document);
        writeAnnotation(document, page, a, element, colors.get(page + ":" + a.index()), annots);
      }
    }

    List<String> out = new ArrayList<>(List.of("<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">"));
    List<String> fieldLines = new ArrayList<>();
    writeFields(roots, 2, fieldLines);
    if (!fieldLines.isEmpty()) { out.add("  <fields>"); out.addAll(fieldLines); out.add("  </fields>"); }
    if (!annots.isEmpty()) { out.add("  <annots>"); out.addAll(annots); out.add("  </annots>"); }
    out.add("</xfdf>");
    return String.join("\n", out) + "\n";
  }

  private static void writeAnnotation(PdfDocument document, int page, PdfAnnotation a, String element, int[] color,
                                      List<String> out) {
    float[] n = new float[13];
    String[] s = document.call(h -> Native.xfdfAnnotation(h, page, a.index(), n));
    if (s == null) return;
    List<String[]> attrs = new ArrayList<>();
    attrs.add(new String[] { "page", String.valueOf(page) });
    attrs.add(new String[] { "rect", f(a.rect().left()) + "," + f(a.rect().bottom()) + "," + f(a.rect().right()) + "," + f(a.rect().top()) });
    if (color != null) attrs.add(new String[] { "color", String.format("#%02X%02X%02X", color[0], color[1], color[2]) });
    if (n[2] != 0 && n[3] != 1) attrs.add(new String[] { "opacity", f(n[3]) });
    List<String> flags = new ArrayList<>();
    int bits = (int) n[1];
    for (int bit = 0; bit < FLAG_NAMES.length; bit++) if ((bits & (1 << bit)) != 0) flags.add(FLAG_NAMES[bit]);
    if (!flags.isEmpty()) attrs.add(new String[] { "flags", String.join(",", flags) });
    String[] keys = { null, "name", "title", "date", "creationdate" };
    for (int i = 1; i <= 4; i++) if (orNull(s[i]) != null) attrs.add(new String[] { keys[i], s[i] });
    switch (a.kind()) {
      case HIGHLIGHT, UNDERLINE, STRIKEOUT, SQUIGGLY -> {
        float[] q = document.call(h -> Native.annotationQuads(h, page, a.index()));
        List<String> coords = new ArrayList<>();
        for (float v : q) coords.add(f(v));
        attrs.add(new String[] { "coords", String.join(",", coords) });
      }
      case INK -> { if (n[4] != 0) attrs.add(new String[] { "width", f(n[5]) }); }
      case TEXT -> { if (orNull(s[6]) != null) attrs.add(new String[] { "icon", s[6] }); }
      case LINE -> {
        if (n[6] != 0) {
          attrs.add(new String[] { "start", f(n[7]) + "," + f(n[8]) });
          attrs.add(new String[] { "end", f(n[9]) + "," + f(n[10]) });
        }
      }
      default -> { }
    }

    StringBuilder open = new StringBuilder("    <" + element);
    for (String[] kv : attrs) open.append(' ').append(kv[0]).append("=\"").append(XfdfXml.escapeAttribute(kv[1])).append('"');
    out.add(open.append('>').toString());
    if (a.kind() == PdfAnnotation.Kind.INK) {
      out.add("      <inklist>");
      for (int stroke = 0; stroke < (int) n[12]; stroke++) {
        final int k = stroke;
        float[] points = document.call(h -> Native.inkStroke(h, page, a.index(), k));
        List<String> pairs = new ArrayList<>();
        for (int i = 0; i + 1 < points.length; i += 2) pairs.add(f(points[i]) + "," + f(points[i + 1]));
        out.add("        <gesture>" + String.join(";", pairs) + "</gesture>");
      }
      out.add("      </inklist>");
    }
    if (orNull(s[0]) != null) out.add("      <contents>" + XfdfXml.escapeText(s[0]) + "</contents>");
    if (a.kind() == PdfAnnotation.Kind.FREE_TEXT && orNull(s[5]) != null) {
      out.add("      <defaultappearance>" + XfdfXml.escapeText(s[5]) + "</defaultappearance>");
    }
    out.add("    </" + element + ">");
  }

  // ---- import ---------------------------------------------------------------------------

  private static void collectFields(XfdfXml.Element element, String prefix, List<Map.Entry<String, List<String>>> out) {
    for (XfdfXml.Element child : element.children()) {
      if (!child.name().equals("field")) continue;
      String part = child.attributes().getOrDefault("name", "");
      String name = prefix.isEmpty() ? part : prefix + "." + part;
      List<String> values = new ArrayList<>();
      for (XfdfXml.Element v : child.children()) if (v.name().equals("value")) values.add(v.text());
      if (!values.isEmpty()) out.add(Map.entry(name, values));
      collectFields(child, name, out);
    }
  }

  private static List<Float> numbers(String text) {
    if (text == null) return null;
    List<Float> out = new ArrayList<>();
    for (String part : text.split("[,;\\s]+")) {
      if (part.isEmpty()) continue;
      try {
        float v = Float.parseFloat(part);
        if (!Float.isFinite(v)) return null;
        out.add(v);
      } catch (NumberFormatException e) {
        return null;
      }
    }
    return out.isEmpty() ? null : out;
  }

  private static int[] colorAttribute(Map<String, String> a) {
    String text = a.get("color");
    if (text == null || !text.matches("#[0-9a-fA-F]{6}")) return null;
    int v = Integer.parseInt(text.substring(1), 16);
    double opacity = 1;
    try { opacity = Double.parseDouble(a.getOrDefault("opacity", "1")); } catch (NumberFormatException ignored) { }
    if (!Double.isFinite(opacity)) opacity = 1;
    return new int[] { (v >> 16) & 255, (v >> 8) & 255, v & 255, channel(opacity) };
  }

  /**
   * Sets one XFDF field on every widget with its name. Everything is checked before the
   * first write, so a value no widget can take changes nothing; null when set.
   */
  private static PdfXfdfSkip.Reason setField(PdfDocument document, List<Widget> widgets, List<String> values) {
    for (Widget w : widgets) if (w.field().readOnly()) return PdfXfdfSkip.Reason.READ_ONLY_FIELD;
    Widget first = widgets.get(0);
    for (Widget w : widgets) if (w.field().kind() != first.field().kind()) return PdfXfdfSkip.Reason.INVALID_VALUE;
    String value = values.get(0);
    List<Runnable> writes = new ArrayList<>();
    switch (first.field().kind()) {
      case TEXT_FIELD -> { for (Widget w : widgets) writes.add(() -> document.page(w.page()).setFieldText(w.field().index(), value)); }
      case CHECK_BOX -> {
        // Check boxes sharing a name each carry their own export value; the value turns on the
        // ones it names and off the rest.
        java.util.function.Predicate<Widget> on = w -> value.equals(w.exportValue() == null ? "Yes" : w.exportValue())
            || (w.exportValue() == null && value.equals("On"));
        if (!value.equals("Off") && widgets.stream().noneMatch(on)) return PdfXfdfSkip.Reason.INVALID_VALUE;
        for (Widget w : widgets) {
          boolean checked = !value.equals("Off") && on.test(w);
          writes.add(() -> document.page(w.page()).setFieldChecked(w.field().index(), checked));
        }
      }
      case RADIO_BUTTON -> {
        if (value.equals("Off")) {
          for (Widget w : widgets) writes.add(() -> document.page(w.page()).setFieldChecked(w.field().index(), false));
        } else {
          Widget match = widgets.stream().filter(w -> value.equals(w.exportValue())).findFirst().orElse(null);
          if (match == null) return PdfXfdfSkip.Reason.INVALID_VALUE;
          writes.add(() -> document.page(match.page()).setFieldChecked(match.field().index(), true));
        }
      }
      case COMBO_BOX, LIST_BOX -> {
        if (!first.options().containsAll(values)) return PdfXfdfSkip.Reason.INVALID_VALUE;
        boolean combo = first.field().kind() == PdfFormField.Kind.COMBO_BOX;
        for (Widget w : widgets) {
          for (int i = 0; i < first.options().size(); i++) {
            boolean selected = combo ? first.options().get(i).equals(value) : values.contains(first.options().get(i));
            if (combo && !selected) continue;
            final int option = i;
            writes.add(() -> {
              int code = document.call(h -> Native.setFieldOption(h, w.page(), w.field().index(), option, selected));
              if (code != 0) throw PdfError.fromNative(code);
            });
          }
        }
      }
      default -> { return PdfXfdfSkip.Reason.INVALID_VALUE; }
    }
    try {
      for (Runnable write : writes) write.run();
    } catch (PdfError e) {
      return PdfXfdfSkip.Reason.WRITE_FAILED;
    }
    return null;
  }

  private static PdfXfdfSkip addAnnotation(PdfDocument document, int pageCount, XfdfXml.Element element) {
    Map<String, String> a = element.attributes();
    String pageText = a.get("page");
    Integer page = pageText != null && pageText.matches("\\d+") ? Integer.valueOf(pageText) : null;
    java.util.function.Function<PdfXfdfSkip.Reason, PdfXfdfSkip> skip = r -> new PdfXfdfSkip(element.name(), page, r);

    if (!SUPPORTED.contains(element.name())) return skip.apply(PdfXfdfSkip.Reason.UNSUPPORTED_TYPE);
    if (page == null) return skip.apply(PdfXfdfSkip.Reason.MISSING_ATTRIBUTE);
    if (page >= pageCount) return skip.apply(PdfXfdfSkip.Reason.PAGE_OUT_OF_RANGE);

    int[] color = colorAttribute(a);
    String contents = null;
    for (XfdfXml.Element c : element.children()) if (c.name().equals("contents")) { contents = c.text(); break; }
    try {
      int index;
      PdfPage target = document.page(page);
      switch (element.name()) {
        case "ink" -> {
          List<List<PdfPage.Point>> strokes = new ArrayList<>();
          for (XfdfXml.Element list : element.children()) {
            if (!list.name().equals("inklist")) continue;
            for (XfdfXml.Element g : list.children()) {
              if (!g.name().equals("gesture")) continue;
              List<Float> n = numbers(g.text());
              if (n == null || n.size() < 2) continue;
              List<PdfPage.Point> stroke = new ArrayList<>();
              for (int i = 0; i + 1 < n.size(); i += 2) stroke.add(new PdfPage.Point(n.get(i), n.get(i + 1)));
              strokes.add(stroke);
            }
          }
          if (strokes.isEmpty()) return skip.apply(PdfXfdfSkip.Reason.MISSING_ATTRIBUTE);
          float width = 2;
          try { float w = Float.parseFloat(a.getOrDefault("width", "")); if (Float.isFinite(w) && w > 0) width = w; }
          catch (NumberFormatException ignored) { }
          int[] c = color == null ? new int[] { 0, 0, 0, 255 } : color;
          index = target.addInk(strokes, c[0], c[1], c[2], width);
        }
        case "text" -> {
          List<Float> r = numbers(a.get("rect"));
          if (r == null || r.size() != 4) return skip.apply(PdfXfdfSkip.Reason.MISSING_ATTRIBUTE);
          int[] c = color == null ? new int[] { 255, 255, 0, 128 } : color;
          final String text = contents == null ? "" : contents;
          index = document.call(h -> Native.addNoteInRect(h, page, r.get(0), r.get(1), r.get(2), r.get(3), text, c[0], c[1], c[2], c[3]));
          if (index < 0) throw PdfError.fromNative(index);
        }
        default -> {
          List<Float> c = numbers(a.get("coords"));
          if (c == null || c.size() < 8 || c.size() % 8 != 0) return skip.apply(PdfXfdfSkip.Reason.MISSING_ATTRIBUTE);
          List<PdfPage.Quad> quads = new ArrayList<>();
          for (int i = 0; i < c.size(); i += 8) {
            quads.add(new PdfPage.Quad(c.get(i), c.get(i + 1), c.get(i + 2), c.get(i + 3), c.get(i + 4), c.get(i + 5), c.get(i + 6), c.get(i + 7)));
          }
          PdfAnnotation.Kind kind = switch (element.name()) {
            case "highlight" -> PdfAnnotation.Kind.HIGHLIGHT;
            case "underline" -> PdfAnnotation.Kind.UNDERLINE;
            default -> PdfAnnotation.Kind.STRIKEOUT;
          };
          int[] fallback = switch (kind) {
            case HIGHLIGHT -> new int[] { 255, 255, 0, 128 };
            case UNDERLINE -> new int[] { 0, 0, 255, 255 };
            default -> new int[] { 255, 0, 0, 255 };
          };
          int[] col = color == null ? fallback : color;
          index = target.addMarkup(kind, quads, col[0], col[1], col[2], col[3]);
        }
      }
      String[][] strings = { { "NM", a.get("name") }, { "T", a.get("title") }, { "M", a.get("date") },
          { "CreationDate", a.get("creationdate") }, { "Contents", element.name().equals("text") ? null : contents } };
      for (String[] kv : strings) {
        if (kv[1] == null) continue;
        final int at = index;
        int code = document.call(h -> Native.setAnnotationString(h, page, at, kv[0], kv[1]));
        if (code != 0) return skip.apply(PdfXfdfSkip.Reason.WRITE_FAILED);
      }
    } catch (PdfError e) {
      return skip.apply(PdfXfdfSkip.Reason.WRITE_FAILED);
    }
    return null;
  }

  static PdfXfdfReport importXfdf(PdfDocument document, String xml) {
    XfdfXml.Element root = XfdfXml.parse(xml);
    if (!root.name().equals("xfdf")) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "not valid XFDF: the root element is not <xfdf>");
    }
    List<Map.Entry<String, List<String>>> fields = new ArrayList<>();
    List<XfdfXml.Element> annots = new ArrayList<>();
    for (XfdfXml.Element section : root.children()) {
      if (section.name().equals("fields")) collectFields(section, "", fields);
      if (section.name().equals("annots")) annots.addAll(section.children());
    }

    List<PdfXfdfSkip> skipped = new ArrayList<>();
    int fieldsSet = 0;
    int annotationsAdded = 0;
    if (!fields.isEmpty()) {
      Map<String, List<Widget>> byName = new HashMap<>();
      for (Widget w : widgets(document)) {
        if (!w.field().name().isEmpty()) byName.computeIfAbsent(w.field().name(), k -> new ArrayList<>()).add(w);
      }
      for (Map.Entry<String, List<String>> field : fields) {
        List<Widget> targets = byName.get(field.getKey());
        PdfXfdfSkip.Reason reason = targets == null ? PdfXfdfSkip.Reason.UNKNOWN_FIELD : setField(document, targets, field.getValue());
        if (reason != null) skipped.add(new PdfXfdfSkip("field", null, reason)); else fieldsSet++;
      }
    }
    int pageCount = document.pageCount();
    for (XfdfXml.Element element : annots) {
      PdfXfdfSkip skip = addAnnotation(document, pageCount, element);
      if (skip != null) skipped.add(skip); else annotationsAdded++;
    }
    return new PdfXfdfReport(fieldsSet, annotationsAdded, List.copyOf(skipped));
  }
}
