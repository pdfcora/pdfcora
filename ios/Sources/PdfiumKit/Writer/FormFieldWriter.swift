import Foundation

/// Creating form fields. PDFium can fill fields but cannot create widgets, so new fields are
/// written here as an incremental update: widget dictionaries, the page's /Annots and the
/// Catalog's /AcroForm, merged with whatever is already there. Mirrors `web/src/writer/formFields.ts`.
enum FormFieldWriter {
    static let da = "/Helv 0 Tf 0 g"

    static func appearance(_ width: Double, _ height: Double, _ body: String) -> PdfValue {
        .raw(Data("<</Type /XObject /Subtype /Form /BBox [0 0 \(format(width)) \(format(height))] /Length \(body.utf8.count)>>\nstream\n\(body)\nendstream".utf8))
    }

    static func format(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }

    static let helvetica: PdfValue = .dictionary([
        ("Type", .name("Font")), ("Subtype", .name("Type1")), ("BaseFont", .name("Helvetica")), ("Encoding", .name("WinAnsiEncoding")),
    ])

    /// /DR with /Helv, which /DA names, added to an inline font dictionary when missing.
    static func resources(_ existing: PdfValue?) -> PdfValue {
        guard let existing else { return .dictionary([("Font", .dictionary([("Helv", helvetica)]))]) }
        guard case .dictionary(let dr) = existing else { return existing }
        switch dr.first(where: { $0.0 == "Font" })?.1 {
        case nil:
            return .dictionary(dr + [("Font", .dictionary([("Helv", helvetica)]))])
        case .dictionary(let fonts)?:
            if fonts.contains(where: { $0.0 == "Helv" }) { return existing }
            return .dictionary(dr.filter { $0.0 != "Font" } + [("Font", .dictionary(fonts + [("Helv", helvetica)]))])
        default:
            return existing
        }
    }

    static func write(_ base: Data, _ fields: [PdfNewFormField]) throws -> Data {
        let bytes = [UInt8](base)
        let info = try TrailerInfo.scan(base)
        let xref = try Xref.build(bytes)
        let (catalogNumber, catalog) = try PdfReader.catalog(bytes)
        let pages = PdfReader.pages(bytes, xref, catalog)

        var next = info.nextObjectNumber
        var objects: [Int: PdfValue] = [:]
        var widgetsByPage: [Int: [PdfValue]] = [:]
        var fieldRefs: [PdfValue] = []

        for field in fields {
            let page = pages[field.pageIndex]
            let widget = next; next += 1
            let r = field.rect
            var entries: [(String, PdfValue)] = [
                ("Type", .name("Annot")), ("Subtype", .name("Widget")), ("T", .string(field.name)),
            ]
            if let tooltip = field.tooltip { entries.append(("TU", .string(tooltip))) }
            entries += [("Rect", .array([r.left, r.bottom, r.right, r.top].map { .real($0) })), ("F", .integer(4)),
                        ("P", .reference(page)), ("DA", .string(da))]
            switch field.kind {
            case .text:
                entries.append(("FT", .name("Tx")))
            case .checkBox:
                let w = r.right - r.left, h = r.top - r.bottom
                let on = next, off = next + 1
                next += 2
                // A tick drawn as a path, so the appearance needs no font.
                let tick = "q 0 g 1.5 w \(format(w * 0.2)) \(format(h * 0.5)) m \(format(w * 0.42)) \(format(h * 0.22)) l \(format(w * 0.8)) \(format(h * 0.8)) l S Q"
                objects[on] = appearance(w, h, tick)
                objects[off] = appearance(w, h, "")
                entries += [("FT", .name("Btn")), ("V", .name("Off")), ("AS", .name("Off")),
                            ("AP", .dictionary([("N", .dictionary([("Yes", .reference(on)), ("Off", .reference(off))]))]))]
            }
            objects[widget] = .dictionary(entries)
            fieldRefs.append(.reference(widget))
            widgetsByPage[field.pageIndex, default: []].append(.reference(widget))
        }

        for (pageIndex, widgets) in widgetsByPage {
            let number = pages[pageIndex]
            guard case .dictionary(let page)? = PdfReader.object(bytes, xref, number) else {
                throw PdfError.saveFailed(reason: "fields: page \(pageIndex) is unreadable")
            }
            if let annotsNumber = PdfReader.reference(.dictionary(page), "Annots") {
                guard case .array(let existing)? = PdfReader.object(bytes, xref, annotsNumber) else {
                    throw PdfError.saveFailed(reason: "fields: page \(pageIndex) annotations are unreadable")
                }
                objects[annotsNumber] = .array(existing + widgets)
            } else {
                var existing: [PdfValue] = []
                if case .array(let inline)? = PdfReader.entry(.dictionary(page), "Annots") { existing = inline }
                objects[number] = .dictionary(page.filter { $0.0 != "Annots" } + [("Annots", .array(existing + widgets))])
            }
        }

        let acroFormNumber = PdfReader.reference(catalog, "AcroForm")
        var acroForm: [(String, PdfValue)] = []
        if let acroFormNumber, case .dictionary(let entries)? = PdfReader.object(bytes, xref, acroFormNumber) { acroForm = entries }
        else if case .dictionary(let entries)? = PdfReader.entry(catalog, "AcroForm") { acroForm = entries }
        let acro = PdfValue.dictionary(acroForm)

        var merged = acroForm.filter { !["NeedAppearances", "DA", "DR"].contains($0.0) }
        if let fieldsNumber = PdfReader.reference(acro, "Fields") {
            var listed: [PdfValue] = []
            if case .array(let items)? = PdfReader.object(bytes, xref, fieldsNumber) { listed = items }
            objects[fieldsNumber] = .array(listed + fieldRefs)
        } else {
            var listed: [PdfValue] = []
            if case .array(let items)? = PdfReader.entry(acro, "Fields") { listed = items }
            merged = merged.filter { $0.0 != "Fields" } + [("Fields", .array(listed + fieldRefs))]
        }
        merged += [("NeedAppearances", .boolean(true)), ("DA", PdfReader.entry(acro, "DA") ?? .string(da)),
                   ("DR", resources(PdfReader.entry(acro, "DR")))]

        if let acroFormNumber {
            objects[acroFormNumber] = .dictionary(merged)
        } else {
            guard case .dictionary(let entries) = catalog else { throw PdfError.saveFailed(reason: "fields: no catalog") }
            objects[catalogNumber] = .dictionary(entries.filter { $0.0 != "AcroForm" } + [("AcroForm", .dictionary(merged))])
        }
        return try PdfWriter.appendUpdate(to: base, objects: objects)
    }
}
