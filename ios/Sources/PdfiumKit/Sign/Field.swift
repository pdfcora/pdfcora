import Foundation

/// Placing a signature field in a document.
///
/// Everything except the cryptography. The field, its signature dictionary and the
/// AcroForm entry are appended as an incremental update, with a fixed-size `/Contents`
/// placeholder that the signer patches in place afterwards.
///
/// The placeholder's size is fixed because `/ByteRange` records absolute offsets: writing
/// the signature by re-serialising would shift every offset after it, and the range would
/// then name the wrong bytes.
enum SignatureField {
    struct Options {
        /// Bytes reserved for the signature. 8192 fits RSA-2048 with a timestamp.
        var reservedBytes: Int = 8192
        var reason: String?
        var contactInfo: String?
        var fieldName: String?
        var pageIndex: Int = 0
        /// Declared up front because it is written into the signed bytes before the CMS
        /// exists, so it must match what the signer produces. `ETSI.CAdES.detached` is
        /// PAdES and requires CAdES-BES; strict verifiers reject a plain PKCS#7 under it.
        var subFilter: String = "ETSI.CAdES.detached"
    }

    struct Placement {
        let bytes: [UInt8]
        /// Offset of the `<` opening the `/Contents` hex string.
        let contentsAt: Int
        /// Length of the whole hex string, angle brackets included.
        let contentsLength: Int
        /// `[0, contentsAt, contentsAt + contentsLength, rest]`.
        let byteRange: [Int]
    }

    /// Every offset is written this wide so patching cannot move a single byte.
    private static let offsetWidth = 10

    static func place(in base: Data, options: Options) throws -> Placement {
        let bytes = [UInt8](base)
        // scanTrailer refuses encrypted documents, which is right here too: the strings
        // about to be written would have to be encrypted with the document key.
        let info = try TrailerInfo.scan(base)
        let xref = try Xref.build(bytes)
        let (catalogNumber, catalog) = try PdfReader.catalog(bytes)

        let first = info.nextObjectNumber
        let signatureNumber = first, widgetNumber = first + 1, acroFormNumber = first + 2

        let pageNumber = findPage(bytes, xref, catalog, options.pageIndex)
        let page = pageNumber.flatMap { PdfReader.object(bytes, xref, $0) }

        var objects: [Int: PdfValue] = [:]

        var signature: [(String, PdfValue)] = [
            ("Type", .name("Sig")),
            ("Filter", .name("Adobe.PPKLite")),
            ("SubFilter", .name(options.subFilter)),
            // Placeholders: fixed width, patched once the real offsets are known.
            ("ByteRange", .raw(Data("[\(pad(0)) \(pad(0)) \(pad(0)) \(pad(0))]".utf8))),
            ("Contents", .raw(Data("<\(String(repeating: "0", count: options.reservedBytes * 2))>".utf8))),
            ("M", .string(pdfDate(Date()))),
        ]
        if let reason = options.reason { signature.append(("Reason", .string(reason))) }
        if let contact = options.contactInfo { signature.append(("ContactInfo", .string(contact))) }
        objects[signatureNumber] = .dictionary(signature)

        var widget: [(String, PdfValue)] = [
            ("Type", .name("Annot")),
            ("Subtype", .name("Widget")),
            ("FT", .name("Sig")),
            ("T", .string(options.fieldName ?? "Signature\(Int(Date().timeIntervalSince1970) % 100000)")),
            ("V", .reference(signatureNumber)),
            // An invisible signature: zero rect, hidden and not printed. Valid without an
            // appearance stream, which is why the first release does not draw one.
            ("Rect", .array([.integer(0), .integer(0), .integer(0), .integer(0)])),
            ("F", .integer(132)),
        ]
        if let pageNumber { widget.append(("P", .reference(pageNumber))) }
        objects[widgetNumber] = .dictionary(widget)

        // Merge rather than replace: an existing AcroForm carries /DR, /DA and the
        // document's other fields, and dropping them would break every form in the file.
        let existing = acroForm(bytes, xref, catalog)
        var acro = existing?.filter { $0.0 != "Fields" && $0.0 != "SigFlags" } ?? []
        acro.append(("Fields", .array(fields(existing) + [.reference(widgetNumber)])))
        acro.append(("SigFlags", .integer(3)))
        objects[acroFormNumber] = .dictionary(acro)

        var catalogEntries = dictionaryEntries(catalog).filter { $0.0 != "AcroForm" }
        catalogEntries.append(("AcroForm", .reference(acroFormNumber)))
        objects[catalogNumber] = .dictionary(catalogEntries)

        if let pageNumber, let page {
            var entries = dictionaryEntries(page).filter { $0.0 != "Annots" }
            entries.append(("Annots", .array(annots(bytes, xref, page) + [.reference(widgetNumber)])))
            objects[pageNumber] = .dictionary(entries)
        }

        let written = try PdfWriter.appendUpdate(to: base, objects: objects)
        return try patchByteRange([UInt8](written), reservedBytes: options.reservedBytes)
    }

    /// Rewrites the `/ByteRange` placeholder with the real offsets. Both the placeholder
    /// and the values are `offsetWidth` digits wide, so nothing moves.
    private static func patchByteRange(_ bytes: [UInt8], reservedBytes: Int) throws -> Placement {
        let text = latin1(bytes)
        guard let contentsRange = text.range(of: "/Contents <", options: .backwards) else {
            throw Der.Failure(reason: "sign: the placeholder went missing")
        }
        guard let rangeRange = text.range(of: "/ByteRange [", options: .backwards) else {
            throw Der.Failure(reason: "sign: the byte range went missing")
        }

        let contentsAt = text.distance(from: text.startIndex, to: contentsRange.lowerBound)
            + "/Contents ".count
        let contentsLength = reservedBytes * 2 + 2
        let byteRange = [
            0, contentsAt,
            contentsAt + contentsLength,
            bytes.count - (contentsAt + contentsLength),
        ]

        var out = bytes
        let at = text.distance(from: text.startIndex, to: rangeRange.lowerBound) + "/ByteRange ".count
        let written = Array("[\(byteRange.map(pad).joined(separator: " "))]".utf8)
        out.replaceSubrange(at..<(at + written.count), with: written)

        return Placement(bytes: out, contentsAt: contentsAt,
                         contentsLength: contentsLength, byteRange: byteRange)
    }

    private static func pad(_ value: Int) -> String {
        String(format: "%0\(offsetWidth)d", value)
    }

    /// `D:YYYYMMDDHHmmSS+00'00'`, the form the reader already parses.
    private static func pdfDate(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let p = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "D:%04d%02d%02d%02d%02d%02d+00'00'",
                      p.year ?? 0, p.month ?? 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0)
    }

    private static func dictionaryEntries(_ value: PdfValue) -> [(String, PdfValue)] {
        if case .dictionary(let entries) = value { return entries }
        return []
    }

    /// `/AcroForm` may be an inline dictionary or a reference; real files use both.
    private static func acroForm(
        _ bytes: [UInt8], _ xref: [Int: Xref.Entry], _ catalog: PdfValue
    ) -> [(String, PdfValue)]? {
        if let number = PdfReader.reference(catalog, "AcroForm") {
            return PdfReader.object(bytes, xref, number).map(dictionaryEntries)
        }
        return PdfReader.entry(catalog, "AcroForm").map(dictionaryEntries)
    }

    private static func fields(_ acroForm: [(String, PdfValue)]?) -> [PdfValue] {
        guard let value = acroForm?.first(where: { $0.0 == "Fields" })?.1,
              case .array(let items) = value else { return [] }
        return items
    }

    /// `/Annots` may likewise be inline or a reference.
    private static func annots(
        _ bytes: [UInt8], _ xref: [Int: Xref.Entry], _ page: PdfValue
    ) -> [PdfValue] {
        if case .array(let inline)? = PdfReader.entry(page, "Annots") { return inline }
        guard let number = PdfReader.reference(page, "Annots"),
              case .array(let items)? = PdfReader.object(bytes, xref, number) else { return [] }
        return items
    }

    /// Walks `/Pages` to the requested leaf, descending through intermediate nodes.
    private static func findPage(
        _ bytes: [UInt8], _ xref: [Int: Xref.Entry], _ catalog: PdfValue, _ wanted: Int
    ) -> Int? {
        guard let root = PdfReader.reference(catalog, "Pages") else { return nil }
        var seen = 0

        func visit(_ number: Int, _ depth: Int) -> Int? {
            if depth > 32 { return nil }                  // malformed trees can cycle
            guard let node = PdfReader.object(bytes, xref, number) else { return nil }

            if let type = PdfReader.entry(node, "Type"), PdfReader.isName(type, "Page") {
                defer { seen += 1 }
                return seen == wanted ? number : nil
            }
            guard case .array(let kids)? = PdfReader.entry(node, "Kids") else { return nil }
            for kid in kids {
                guard case .reference(let kidNumber, _) = kid else { continue }
                if let found = visit(kidNumber, depth + 1) { return found }
            }
            return nil
        }
        return visit(root, 0)
    }
}
