import Foundation
import CPdfium

/// What XFDF carries about an annotation that the public `PdfAnnotation` does not.
struct XfdfAnnotationEntries {
    var name: String?
    var title: String?
    var modified: String?
    var created: String?
    var opacity: Double?
    var borderWidth: Double?
    var icon: String?
    var defaultAppearance: String?
}

private let flagNames = ["invisible", "hidden", "print", "nozoom", "norotate", "noview", "readonly", "locked",
                         "togglenoview", "lockedcontents"]

extension PdfDocument {
    /// The form values and annotations as XFDF (ISO 19444-1), for other PDF tools or a backend.
    /// Widgets and links are not included; neither are appearances or rich text.
    public func exportXFDF() throws -> String {
        _ = try requireHandle()
        let pages = pageCount
        let colors = try annotationColors()
        var widgetsByName: [(String, [PdfFormField])] = []
        var annots: [String] = []

        for pageIndex in 0..<pages {
            for field in try formFields(pageIndex: pageIndex).sorted(by: { $0.base.annotationIndex < $1.base.annotationIndex }) {
                guard let name = field.base.name else { continue }
                if let at = widgetsByName.firstIndex(where: { $0.0 == name }) {
                    widgetsByName[at].1.append(field)
                } else {
                    widgetsByName.append((name, [field]))
                }
            }
            for annotation in try annotations(pageIndex: pageIndex) {
                guard let element = Self.xfdfElement(annotation) else { continue }
                let base = annotation.base
                let entries = try annotationEntries(pageIndex: pageIndex, index: base.index)
                write(annotation, element: element, entries: entries,
                      color: colors["\(pageIndex):\(base.index)"] ?? base.color, into: &annots)
            }
        }

        var out = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                   "<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">"]
        var fieldLines: [String] = []
        Self.writeFields(Self.fieldTree(widgetsByName), depth: 2, into: &fieldLines)
        if !fieldLines.isEmpty { out += ["  <fields>"] + fieldLines + ["  </fields>"] }
        if !annots.isEmpty { out += ["  <annots>"] + annots + ["  </annots>"] }
        out.append("</xfdf>")
        return out.joined(separator: "\n") + "\n"
    }

    private static func xfdfElement(_ annotation: PdfAnnotation) -> String? {
        switch annotation {
        case .highlight: return "highlight"
        case .underline: return "underline"
        case .strikeout: return "strikeout"
        case .squiggly: return "squiggly"
        case .ink: return "ink"
        case .text: return "text"
        case .square: return "square"
        case .circle: return "circle"
        case .line: return "line"
        case .freeText: return "freetext"
        case .stamp: return "stamp"
        case .fileAttachment: return "fileattachment"
        case .link, .widget, .unknown: return nil
        }
    }

    // MARK: - Fields

    private final class FieldNode {
        let name: String
        var values: [String]?
        var children: [FieldNode] = []
        init(name: String) { self.name = name }
    }

    private static func values(_ widgets: [PdfFormField]) -> [String]? {
        guard let first = widgets.first else { return nil }
        switch first {
        case .text(let f): return f.value.isEmpty ? nil : [f.value]
        case .checkBox, .radioButton:
            for widget in widgets {
                if case .checkBox(let t) = widget, t.isChecked { return [t.exportValue ?? "Yes"] }
                if case .radioButton(let t) = widget, t.isChecked { return [t.exportValue ?? "Yes"] }
            }
            return ["Off"]
        case .comboBox(let f): return f.value.isEmpty ? nil : [f.value]
        case .listBox(let f):
            let selected = f.selectedIndices.compactMap { f.options.indices.contains($0) ? f.options[$0] : nil }
            return selected.isEmpty ? nil : selected
        case .pushButton, .signature, .unknown: return nil
        }
    }

    private static func fieldTree(_ byName: [(String, [PdfFormField])]) -> [FieldNode] {
        var roots: [FieldNode] = []
        for (fullName, widgets) in byName {
            guard let values = values(widgets) else { continue }
            var level = roots
            var node: FieldNode?
            var path: [FieldNode] = []
            for part in fullName.split(separator: ".", omittingEmptySubsequences: false).map(String.init) {
                if let existing = level.first(where: { $0.name == part }) {
                    node = existing
                } else {
                    let created = FieldNode(name: part)
                    if let parent = path.last { parent.children.append(created) } else { roots.append(created) }
                    node = created
                }
                path.append(node!)
                level = node!.children
            }
            node?.values = values
        }
        return roots
    }

    private static func writeFields(_ nodes: [FieldNode], depth: Int, into out: inout [String]) {
        let pad = String(repeating: "  ", count: depth)
        for node in nodes {
            out.append("\(pad)<field name=\"\(Xfdf.escapeAttribute(node.name))\">")
            for value in node.values ?? [] { out.append("\(pad)  <value>\(Xfdf.escapeText(value))</value>") }
            writeFields(node.children, depth: depth + 1, into: &out)
            out.append("\(pad)</field>")
        }
    }

    // MARK: - Annotations

    private func write(_ annotation: PdfAnnotation, element: String, entries e: XfdfAnnotationEntries,
                       color: PdfColor?, into out: inout [String]) {
        let base = annotation.base
        let f = Xfdf.format
        var attrs: [(String, String)] = [
            ("page", String(base.pageIndex)),
            ("rect", [base.rect.left, base.rect.bottom, base.rect.right, base.rect.top].map(f).joined(separator: ",")),
        ]
        if let color { attrs.append(("color", String(format: "#%02X%02X%02X", color.red, color.green, color.blue))) }
        if let opacity = e.opacity, opacity != 1 { attrs.append(("opacity", f(opacity))) }
        let flags = flagNames.enumerated().filter { base.flags.rawValue & (1 << $0.offset) != 0 }.map(\.element)
        if !flags.isEmpty { attrs.append(("flags", flags.joined(separator: ","))) }
        if let v = e.name { attrs.append(("name", v)) }
        if let v = e.title { attrs.append(("title", v)) }
        if let v = e.modified { attrs.append(("date", v)) }
        if let v = e.created { attrs.append(("creationdate", v)) }

        var strokes: [[PdfPoint]]?
        switch annotation {
        case .highlight(let m), .underline(let m), .strikeout(let m), .squiggly(let m):
            let coords = m.quads.flatMap { [$0.p1, $0.p2, $0.p3, $0.p4] }.flatMap { [f($0.x), f($0.y)] }
            attrs.append(("coords", coords.joined(separator: ",")))
        case .ink(let ink):
            strokes = ink.strokes
            if let width = e.borderWidth { attrs.append(("width", f(width))) }
        case .text:
            if let icon = e.icon { attrs.append(("icon", icon)) }
        case .line(let line):
            attrs.append(("start", "\(f(line.start.x)),\(f(line.start.y))"))
            attrs.append(("end", "\(f(line.end.x)),\(f(line.end.y))"))
        default:
            break
        }

        out.append("    <\(element) " + attrs.map { "\($0.0)=\"\(Xfdf.escapeAttribute($0.1))\"" }.joined(separator: " ") + ">")
        if let strokes {
            out.append("      <inklist>")
            for stroke in strokes {
                out.append("        <gesture>" + stroke.map { "\(f($0.x)),\(f($0.y))" }.joined(separator: ";") + "</gesture>")
            }
            out.append("      </inklist>")
        }
        if let contents = base.contents { out.append("      <contents>\(Xfdf.escapeText(contents))</contents>") }
        if case .freeText = annotation, let da = e.defaultAppearance {
            out.append("      <defaultappearance>\(Xfdf.escapeText(da))</defaultappearance>")
        }
        out.append("    </\(element)>")
    }

    func annotationEntries(pageIndex: Int, index: Int) throws -> XfdfAnnotationEntries {
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_GetAnnot(page, Int32(index)) else { return XfdfAnnotationEntries() }
        defer { FPDFPage_CloseAnnot(annot) }
        var entries = XfdfAnnotationEntries()
        entries.name = annotString(annot, key: "NM")
        entries.title = annotString(annot, key: "T")
        entries.modified = annotString(annot, key: "M")
        entries.created = annotString(annot, key: "CreationDate")
        entries.icon = annotString(annot, key: "Name")
        entries.defaultAppearance = annotString(annot, key: "DA")
        var opacity: Float = 0
        if FPDFAnnot_GetNumberValue(annot, "CA", &opacity) != 0 { entries.opacity = Double(opacity) }
        var h: Float = 0, v: Float = 0, w: Float = 0
        if FPDFAnnot_GetBorder(annot, &h, &v, &w) != 0 { entries.borderWidth = Double(w) }
        return entries
    }

    /// Each annotation's `/C`, keyed `page:index`, from a full save. PDFium's
    /// `FPDFAnnot_GetColor` refuses once an annotation has an appearance stream, which PDFium
    /// generates for most markup when a page is loaded; `/Annots` order is PDFium's index.
    private func annotationColors() throws -> [String: PdfColor] {
        let bytes = [UInt8](try data(mode: .full))
        let xref = try Xref.build(bytes)
        let catalog = try PdfReader.catalog(bytes).value
        var colors: [String: PdfColor] = [:]
        for (pageIndex, pageNumber) in PdfReader.pages(bytes, xref, catalog).enumerated() {
            guard let page = PdfReader.object(bytes, xref, pageNumber) else { continue }
            var annots: [PdfValue] = []
            if case .array(let inline)? = PdfReader.entry(page, "Annots") {
                annots = inline
            } else if let number = PdfReader.reference(page, "Annots"),
                      case .array(let referenced)? = PdfReader.object(bytes, xref, number) {
                annots = referenced
            }
            for (index, entry) in annots.enumerated() {
                var dictionary: PdfValue? = entry
                if case .reference(let number, _) = entry { dictionary = PdfReader.object(bytes, xref, number) }
                guard let dictionary, let color = Self.color(PdfReader.entry(dictionary, "C")) else { continue }
                colors["\(pageIndex):\(index)"] = color
            }
        }
        return colors
    }

    /// `/C` has 1 (grey), 3 (RGB) or 4 (CMYK) components; none means transparent.
    private static func color(_ value: PdfValue?) -> PdfColor? {
        guard case .array(let items)? = value else { return nil }
        var c: [Double] = []
        for item in items {
            switch item {
            case .integer(let n): c.append(Double(n))
            case .real(let n): c.append(n)
            default: return nil
            }
        }
        func byte(_ v: Double) -> UInt8 { UInt8((min(1, max(0, v)) * 255).rounded()) }
        switch c.count {
        case 1: return PdfColor(red: byte(c[0]), green: byte(c[0]), blue: byte(c[0]))
        case 3: return PdfColor(red: byte(c[0]), green: byte(c[1]), blue: byte(c[2]))
        case 4:
            let k = 1 - c[3]
            return PdfColor(red: byte((1 - c[0]) * k), green: byte((1 - c[1]) * k), blue: byte((1 - c[2]) * k))
        default: return nil
        }
    }
}
