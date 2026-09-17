import Foundation

/// Reading existing objects out of a document.
///
/// Signing must merge `/AcroForm` into the Catalog and a widget into a page's `/Annots`.
/// Replacing either without reading it first would discard everything else it holds.
///
/// Only dictionaries are modelled. Stream bodies are located but not returned, because
/// nothing that rewrites an object needs to reconstruct one.
enum PdfReader {
    /// How far past an object header to look for its dictionary.
    private static let window = 1 << 20

    static func object(_ bytes: [UInt8], _ xref: [Int: Xref.Entry], _ number: Int) -> PdfValue? {
        switch xref[number] {
        case .atOffset(let offset, _):
            return atOffset(bytes, offset, number)
        case .inObjectStream(let stream, let index):
            return fromObjectStream(bytes, xref, stream, index)
        case nil:
            return nil
        }
    }

    /// `N G obj … endobj` at a known offset.
    private static func atOffset(_ bytes: [UInt8], _ offset: Int, _ number: Int) -> PdfValue? {
        guard offset > 0, offset < bytes.count else { return nil }
        let text = latin1(bytes[offset..<min(bytes.count, offset + window)])

        guard let header = objectHeader.firstMatch(
            in: text, range: NSRange(text.startIndex..., in: text)),
            header.range.location == 0,
            let numberRange = Range(header.range(at: 1), in: text),
            Int(text[numberRange]) == number else {
            // A wrong offset points at something that is not this object. Returning nil
            // is right: a caller that then wrote a replacement would corrupt the file.
            return nil
        }

        // Dictionaries and arrays are modelled; a number or string here must not be mistaken
        // for the next object's dictionary.
        guard let headerEnd = Range(header.range, in: text)?.upperBound,
              let at = text[headerEnd...].firstIndex(where: { !$0.isWhitespace }),
              text[at...].hasPrefix("<<") || text[at] == "[" else { return nil }
        return try? PdfDictionaryReader(text).readContainer(from: at)
    }

    /// An object inside a compressed object stream.
    ///
    /// The stream begins with `/N` pairs of "object number, offset", after which
    /// `/First` marks where the objects themselves start.
    private static func fromObjectStream(
        _ bytes: [UInt8], _ xref: [Int: Xref.Entry], _ streamNumber: Int, _ index: Int
    ) -> PdfValue? {
        guard case .atOffset(let offset, _)? = xref[streamNumber] else { return nil }
        let text = latin1(bytes[offset..<min(bytes.count, offset + window)])
        guard let dictAt = text.range(of: "<<"),
              let dictionary = try? PdfDictionaryReader(text).read(from: dictAt.lowerBound),
              case .integer(let count)? = dictionary["N"],
              case .integer(let first)? = dictionary["First"],
              index < count,
              let data = try? Xref.streamBytes(bytes, at: offset, text: text, dictionary: dictionary)
        else { return nil }

        let header = latin1(data.prefix(first))
        let numbers = header.split(whereSeparator: { $0.isWhitespace }).compactMap { Int($0) }
        // Pairs, so the offset of entry `index` is at 2 * index + 1.
        guard numbers.count > index * 2 + 1 else { return nil }
        let start = first + numbers[index * 2 + 1]
        guard start < data.count else { return nil }

        let body = latin1(data[start...])
        guard let at = body.firstIndex(where: { !$0.isWhitespace }),
              body[at...].hasPrefix("<<") || body[at] == "[" else { return nil }
        return try? PdfDictionaryReader(body).readContainer(from: at)
    }

    /// The document Catalog, with the object number so it can be rewritten.
    static func catalog(_ bytes: [UInt8]) throws -> (number: Int, value: PdfValue) {
        let xref = try Xref.build(bytes)
        guard let number = catalogNumber(bytes, xref) else {
            throw Der.Failure(reason: "read: no /Root and no object claims to be a Catalog")
        }
        guard let value = object(bytes, xref, number) else {
            throw Der.Failure(reason: "read: catalog object \(number) is unreadable")
        }
        return (number, value)
    }

    private static func catalogNumber(_ bytes: [UInt8], _ xref: [Int: Xref.Entry]) -> Int? {
        // The trailer's /Root is authoritative; the newest occurrence wins.
        let whole = latin1(bytes)
        let matches = rootRef.matches(in: whole, range: NSRange(whole.startIndex..., in: whole))
        if let last = matches.last, let range = Range(last.range(at: 1), in: whole),
           let number = Int(whole[range]) {
            return number
        }

        // Some malformed files have no usable /Root. Finding the object that calls itself
        // a Catalog is a last resort, and better than failing outright.
        for number in xref.keys.sorted() {
            if case .dictionary(let entries)? = object(bytes, xref, number),
               entries.contains(where: { $0.0 == "Type" && isName($0.1, "Catalog") }) {
                return number
            }
        }
        return nil
    }

    /// The object numbers of the document's pages, in page order.
    static func pages(_ bytes: [UInt8], _ xref: [Int: Xref.Entry], _ catalog: PdfValue) -> [Int] {
        var pages: [Int] = []
        var seen = Set<Int>()
        func visit(_ number: Int, _ depth: Int) {
            guard depth <= 32, seen.insert(number).inserted,        // malformed trees can cycle
                  let node = object(bytes, xref, number) else { return }
            if let type = entry(node, "Type"), isName(type, "Page") { pages.append(number); return }
            guard case .array(let kids)? = entry(node, "Kids") else { return }
            for case .reference(let kid, _) in kids { visit(kid, depth + 1) }
        }
        if let root = reference(catalog, "Pages") { visit(root, 0) }
        return pages
    }

    /// The object number a dictionary's `key` refers to, when it is a reference.
    static func reference(_ value: PdfValue, _ key: String) -> Int? {
        guard case .reference(let number, _)? = entry(value, key) else { return nil }
        return number
    }

    static func entry(_ value: PdfValue, _ key: String) -> PdfValue? {
        guard case .dictionary(let entries) = value else { return nil }
        return entries.first(where: { $0.0 == key })?.1
    }

    static func isName(_ value: PdfValue, _ expected: String) -> Bool {
        if case .name(let text) = value { return text == expected }
        return false
    }

    private static let objectHeader = try! NSRegularExpression(pattern: #"\A\s*(\d+)\s+(\d+)\s+obj\b"#)
    private static let rootRef = try! NSRegularExpression(pattern: #"/Root\s+(\d+)\s+(\d+)\s+R"#)
}
