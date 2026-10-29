import Foundation
import CPdfium

public enum PdfXfdfSkipReason: String, Sendable {
    case unsupportedType, unknownField, readOnlyField, invalidValue, pageOutOfRange, missingAttribute, writeFailed
}

/// An XFDF element import did not apply, and why.
public struct PdfXfdfSkip: Equatable, Sendable {
    /// The XFDF element name, e.g. `field` or `square`.
    public let element: String
    public let page: Int?
    public let reason: PdfXfdfSkipReason

    public init(element: String, page: Int?, reason: PdfXfdfSkipReason) {
        self.element = element; self.page = page; self.reason = reason
    }
}

/// What `importXFDF` applied. Skipped entries are in the order they appear in the XFDF.
public struct PdfXfdfReport: Equatable, Sendable {
    public let fieldsSet: Int
    public let annotationsAdded: Int
    public let skipped: [PdfXfdfSkip]
}

private let supportedAnnotations: Set<String> = ["ink", "text", "highlight", "underline", "strikeout"]

extension PdfDocument {
    /// Applies XFDF: sets the form values it names and adds the ink, note, highlight, underline
    /// and strikeout annotations it carries, keeping their author, name and dates. Everything
    /// else is listed in the report's `skipped`, with a reason. Malformed XML, a DOCTYPE, or
    /// input over 10 MiB is refused with `invalidOperation` before anything is written; a write
    /// PDFium refuses afterwards is reported as `writeFailed`, and earlier writes stay.
    /// Save with a full save to keep the added annotations.
    public func importXFDF(_ xml: String) throws -> PdfXfdfReport {
        _ = try requireHandle()
        let root = try Xfdf.parse(xml)
        guard root.name == "xfdf" else {
            throw PdfError.invalidOperation(reason: "not valid XFDF: the root element is not <xfdf>")
        }

        var fields: [(name: String, values: [String])] = []
        for section in root.children where section.name == "fields" { Self.collectFields(section, prefix: "", into: &fields) }
        let annots = root.children.filter { $0.name == "annots" }.flatMap(\.children)

        var skipped: [PdfXfdfSkip] = []
        var fieldsSet = 0
        var annotationsAdded = 0

        if !fields.isEmpty {
            var widgets: [String: [PdfFormField]] = [:]
            for pageIndex in 0..<pageCount {
                for field in try formFields(pageIndex: pageIndex) {
                    if let name = field.base.name { widgets[name, default: []].append(field) }
                }
            }
            for field in fields {
                let reason = widgets[field.name].map { setField($0, values: field.values) } ?? .unknownField
                if let reason { skipped.append(PdfXfdfSkip(element: "field", page: nil, reason: reason)) } else { fieldsSet += 1 }
            }
        }

        var touched = Set<Int>()
        for element in annots {
            if let skip = addAnnotation(element) {
                skipped.append(skip)
            } else {
                annotationsAdded += 1
                element.attributes["page"].flatMap(Int.init).map { _ = touched.insert($0) }
            }
        }
        // The other SDKs load a page per call, so PDFium generates the new annotations'
        // appearances (and, for ink, grows /Rect by half the line width) the next time the
        // page is read; reopening a saved file does the same. Releasing the cached pages makes
        // this document read the same way.
        for page in touched { releasePage(page) }
        return PdfXfdfReport(fieldsSet: fieldsSet, annotationsAdded: annotationsAdded, skipped: skipped)
    }

    private static func collectFields(_ element: Xfdf.Element, prefix: String, into out: inout [(name: String, values: [String])]) {
        for child in element.children where child.name == "field" {
            let part = child.attributes["name"] ?? ""
            let name = prefix.isEmpty ? part : "\(prefix).\(part)"
            let values = child.children.filter { $0.name == "value" }.map(\.text)
            if !values.isEmpty { out.append((name, values)) }
            collectFields(child, prefix: name, into: &out)
        }
    }

    /// Sets one XFDF field on every widget with its name. Everything is checked before the first
    /// write, so a value no widget can take changes nothing; nil when set.
    private func setField(_ widgets: [PdfFormField], values: [String]) -> PdfXfdfSkipReason? {
        if widgets.contains(where: { $0.base.isReadOnly }) { return .readOnlyField }
        func kind(_ f: PdfFormField) -> Int {
            switch f {
            case .text: return 0
            case .checkBox: return 1
            case .radioButton: return 2
            case .comboBox: return 3
            case .listBox: return 4
            case .pushButton, .signature, .unknown: return 5
            }
        }
        guard widgets.allSatisfy({ kind($0) == kind(widgets[0]) }) else { return .invalidValue }
        func exportOf(_ f: PdfFormField) -> String? {
            switch f {
            case .checkBox(let t), .radioButton(let t): return t.exportValue
            default: return nil
            }
        }
        let value = values.first ?? ""
        var writes: [() throws -> Void] = []
        switch widgets[0] {
        case .text:
            writes = widgets.map { w in { try self.setFormText(pageIndex: w.base.pageIndex, annotationIndex: w.base.annotationIndex, value: value) } }
        case .checkBox:
            // Check boxes sharing a name each carry their own export value; the value turns on the
            // ones it names and off the rest.
            func on(_ f: PdfFormField) -> Bool { value == (exportOf(f) ?? "Yes") || (exportOf(f) == nil && value == "On") }
            if value != "Off" && !widgets.contains(where: on) { return .invalidValue }
            writes = widgets.map { w in {
                try self.setFormChecked(pageIndex: w.base.pageIndex, annotationIndex: w.base.annotationIndex,
                                        checked: value != "Off" && on(w))
            } }
        case .radioButton:
            if value == "Off" {
                writes = widgets.map { w in { try self.setFormChecked(pageIndex: w.base.pageIndex, annotationIndex: w.base.annotationIndex, checked: false) } }
            } else {
                guard let match = widgets.first(where: { exportOf($0) == value }) else { return .invalidValue }
                writes = [{ try self.setFormChecked(pageIndex: match.base.pageIndex, annotationIndex: match.base.annotationIndex, checked: true) }]
            }
        case .comboBox(let choice), .listBox(let choice):
            guard values.allSatisfy(choice.options.contains) else { return .invalidValue }
            let isCombo: Bool = { if case .comboBox = widgets[0] { return true } else { return false } }()
            for w in widgets {
                if isCombo, let index = choice.options.firstIndex(of: value) {
                    writes.append { try self.setFormOption(pageIndex: w.base.pageIndex, annotationIndex: w.base.annotationIndex, optionIndex: index, selected: true) }
                } else if !isCombo {
                    for (index, option) in choice.options.enumerated() {
                        writes.append { try self.setFormOption(pageIndex: w.base.pageIndex, annotationIndex: w.base.annotationIndex,
                                                               optionIndex: index, selected: values.contains(option)) }
                    }
                }
            }
        case .pushButton, .signature, .unknown:
            return .invalidValue
        }
        do {
            for write in writes { try write() }
        } catch {
            return .writeFailed
        }
        return nil
    }

    private static func numbers(_ text: String?) -> [Double]? {
        guard let text else { return nil }
        let parts = text.split(whereSeparator: { ",; \t\n\r".contains($0) }).map { Double($0) }
        guard !parts.isEmpty, parts.allSatisfy({ $0?.isFinite == true }) else { return nil }
        return parts.compactMap { $0 }
    }

    private static func color(_ attributes: [String: String]) -> PdfColor? {
        guard let text = attributes["color"], text.count == 7, text.hasPrefix("#"),
              let v = Int(text.dropFirst(), radix: 16) else { return nil }
        let opacity = Double(attributes["opacity"] ?? "1") ?? 1
        let alpha = UInt8((min(1, max(0, opacity.isFinite ? opacity : 1)) * 255).rounded())
        return PdfColor(red: UInt8((v >> 16) & 255), green: UInt8((v >> 8) & 255), blue: UInt8(v & 255), alpha: alpha)
    }

    /// Creates one annotation; nil when added.
    private func addAnnotation(_ element: Xfdf.Element) -> PdfXfdfSkip? {
        let a = element.attributes
        let page = a["page"].flatMap { $0.allSatisfy(\.isNumber) ? Int($0) : nil }
        func skip(_ reason: PdfXfdfSkipReason) -> PdfXfdfSkip { PdfXfdfSkip(element: element.name, page: page, reason: reason) }

        guard supportedAnnotations.contains(element.name) else { return skip(.unsupportedType) }
        guard let page else { return skip(.missingAttribute) }
        guard page < pageCount else { return skip(.pageOutOfRange) }

        let color = Self.color(a)
        let contents = element.children.first { $0.name == "contents" }?.text
        do {
            let index: Int
            switch element.name {
            case "ink":
                let gestures = element.children.first { $0.name == "inklist" }?.children.filter { $0.name == "gesture" } ?? []
                let strokes: [[PdfPoint]] = gestures.compactMap { Self.numbers($0.text) }.filter { $0.count >= 2 }.map { n in
                    stride(from: 0, to: n.count - 1, by: 2).map { PdfPoint(x: n[$0], y: n[$0 + 1]) }
                }
                guard !strokes.isEmpty else { return skip(.missingAttribute) }
                let width = Double(a["width"] ?? "").flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 2
                index = try addInk(pageIndex: page, strokes: strokes, color: color ?? .black, lineWidth: width)
            case "text":
                guard let r = Self.numbers(a["rect"]), r.count == 4 else { return skip(.missingAttribute) }
                index = try addNote(pageIndex: page, rect: PdfRect(left: r[0], bottom: r[1], right: r[2], top: r[3]),
                                    contents: contents ?? "", color: color ?? .yellow)
            default:
                guard let c = Self.numbers(a["coords"]), c.count >= 8, c.count % 8 == 0 else { return skip(.missingAttribute) }
                let quads = stride(from: 0, to: c.count, by: 8).map { i in
                    PdfQuad(p1: PdfPoint(x: c[i], y: c[i + 1]), p2: PdfPoint(x: c[i + 2], y: c[i + 3]),
                            p3: PdfPoint(x: c[i + 4], y: c[i + 5]), p4: PdfPoint(x: c[i + 6], y: c[i + 7]))
                }
                let (subtype, fallback): (FPDF_ANNOTATION_SUBTYPE, PdfColor) = switch element.name {
                case "highlight": (FPDF_ANNOT_HIGHLIGHT, .yellow)
                case "underline": (FPDF_ANNOT_UNDERLINE, PdfColor(red: 0, green: 0, blue: 255))
                default: (FPDF_ANNOT_STRIKEOUT, PdfColor(red: 255, green: 0, blue: 0))
                }
                index = try addMarkup(pageIndex: page, subtype: subtype, quads: quads, color: color ?? fallback)
            }
            var strings: [(String, String?)] = [("NM", a["name"]), ("T", a["title"]), ("M", a["date"]),
                                                 ("CreationDate", a["creationdate"])]
            if element.name != "text" { strings.append(("Contents", contents)) }
            try setAnnotationStrings(pageIndex: page, index: index, strings)
        } catch {
            return skip(.writeFailed)
        }
        return nil
    }

    private func setAnnotationStrings(pageIndex: Int, index: Int, _ values: [(String, String?)]) throws {
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_GetAnnot(page, Int32(index)) else {
            throw PdfError.invalidOperation(reason: "annotation \(index) is missing")
        }
        defer { FPDFPage_CloseAnnot(annot) }
        for case let (key, value?) in values {
            var units = Array(value.utf16) + [0]
            guard FPDFAnnot_SetStringValue(annot, key, &units) != 0 else {
                throw PdfError.invalidOperation(reason: "could not write /\(key)")
            }
        }
    }
}
