import Foundation

/// Locating every object in a document.
///
/// Signing must merge `/AcroForm` into the Catalog and a widget into a page's `/Annots`.
/// Both are existing objects, so they have to be found before they can be read.
///
/// Both cross-reference styles are walked, following `/Prev` back through every appended
/// update. Newer sections win, which is what an incremental update means.
enum Xref {
    /// Where an object lives: at a file offset, or inside a compressed object stream.
    enum Entry {
        case atOffset(Int, generation: Int)
        case inObjectStream(number: Int, index: Int)
    }

    /// How much of the file to decode when reading a section header or dictionary.
    static let window = 1 << 20

    static func build(_ bytes: [UInt8]) throws -> [Int: Entry] {
        var map: [Int: Entry] = [:]
        var visited = Set<Int>()
        var offset: Int? = try findStartXref(bytes)

        while let current = offset {
            // A malformed file can point /Prev at a section already walked. Stopping is
            // the only safe response; continuing would loop forever on untrusted input.
            if visited.contains(current) { break }
            visited.insert(current)
            offset = try readSection(bytes, at: current, into: &map)
        }

        if map.isEmpty { throw Der.Failure(reason: "xref: no objects were located") }
        return map
    }

    /// Returns the `/Prev` offset, or nil at the end of the chain.
    private static func readSection(
        _ bytes: [UInt8], at offset: Int, into map: inout [Int: Entry]
    ) throws -> Int? {
        let end = min(bytes.count, offset + window)
        guard offset < end else { throw Der.Failure(reason: "xref: offset \(offset) past the file") }
        var text = latin1(bytes[offset..<end])
        var skipped = 0

        // startxref is not always exact; the writer tolerates the same slippage. Latin-1
        // gives one Unicode scalar per byte, so a scalar offset is a byte offset. Not a
        // Character offset: Swift joins "\r\n" into one Character.
        if !starts(text, with: "xref") && !starts(text, with: "<<") && !startsWithObject(text) {
            let probe = String(text.prefix(512))
            guard let at = firstSectionStart(probe) else {
                throw Der.Failure(reason: "xref: nothing recognisable at \(offset)")
            }
            skipped = probe.unicodeScalars.distance(from: probe.unicodeScalars.startIndex, to: at)
            text = String(text.unicodeScalars.dropFirst(skipped))
        }

        return starts(text, with: "xref")
            ? try readTable(text, into: &map)
            : try readStream(bytes, at: offset + skipped, into: &map)
    }

    /// A classic table: `xref`, then subsections of "first count" followed by that
    /// many twenty-byte entries.
    private static func readTable(_ text: String, into map: inout [Int: Entry]) throws -> Int? {
        guard let trailerAt = text.range(of: "trailer") else {
            throw Der.Failure(reason: "xref: table has no trailer")
        }
        let body = Array(text[text.startIndex..<trailerAt.lowerBound])

        // Skip the "xref" keyword itself.
        var i = 0
        while i < body.count, body[i].isWhitespace { i += 1 }
        i += 4

        while i < body.count {
            while i < body.count, body[i].isWhitespace { i += 1 }
            guard let first = readNumber(body, &i) else { break }
            while i < body.count, body[i] == " " { i += 1 }
            guard let count = readNumber(body, &i) else { break }
            while i < body.count, body[i].isWhitespace { i += 1 }

            for offsetInSubsection in 0..<count {
                guard i + 18 <= body.count else { break }
                let offset = Int(String(body[i..<(i + 10)]))
                let generation = Int(String(body[(i + 11)..<(i + 16)]))
                let kind = body[i + 17]

                let number = first + offsetInSubsection
                if kind == "n", let offset, let generation, map[number] == nil {
                    map[number] = .atOffset(offset, generation: generation)
                }
                // Entries are twenty bytes, though some writers use a nineteen-byte
                // line ending; step past whatever whitespace follows.
                i += 18
                while i < body.count, body[i].isWhitespace { i += 1 }
            }
        }

        guard let dictAt = text.range(of: "<<", range: trailerAt.upperBound..<text.endIndex) else {
            throw Der.Failure(reason: "xref: trailer has no dictionary")
        }
        let trailer = try PdfDictionaryReader(text).read(from: dictAt.lowerBound)
        if case .integer(let prev)? = trailer["Prev"] { return prev }
        return nil
    }

    private static func readNumber(_ characters: [Character], _ i: inout Int) -> Int? {
        var digits = ""
        while i < characters.count, characters[i].isNumber {
            digits.append(characters[i]); i += 1
        }
        return digits.isEmpty ? nil : Int(digits)
    }

    /// A cross-reference stream: the table is itself an object, usually Flate-compressed
    /// and PNG-predicted, whose `/W` gives each field's width and `/Index` the objects.
    private static func readStream(
        _ bytes: [UInt8], at offset: Int, into map: inout [Int: Entry]
    ) throws -> Int? {
        let end = min(bytes.count, offset + window)
        let text = latin1(bytes[offset..<end])
        guard let dictAt = text.range(of: "<<") else {
            throw Der.Failure(reason: "xref: no stream dictionary at \(offset)")
        }
        let dictionary = try PdfDictionaryReader(text).read(from: dictAt.lowerBound)
        let data = try streamBytes(bytes, at: offset, text: text, dictionary: dictionary)

        guard case .array(let widthValues)? = dictionary["W"] else {
            throw Der.Failure(reason: "xref: stream has no /W")
        }
        let widths = widthValues.compactMap { value -> Int? in
            if case .integer(let n) = value { return n }
            return nil
        }
        guard widths.count >= 3 else { throw Der.Failure(reason: "xref: malformed /W") }

        var size = 0
        if case .integer(let n)? = dictionary["Size"] { size = n }

        var index = [0, size]
        if case .array(let indexValues)? = dictionary["Index"] {
            index = indexValues.compactMap { value in
                if case .integer(let n) = value { return n }
                return nil
            }
        }

        let rowWidth = widths[0] + widths[1] + widths[2]
        guard rowWidth > 0 else { throw Der.Failure(reason: "xref: zero-width rows") }

        var row = 0
        var pair = 0
        while pair + 1 < index.count {
            var number = index[pair]
            for _ in 0..<index[pair + 1] {
                defer { number += 1; row += 1 }
                let at = row * rowWidth
                guard at + rowWidth <= data.count else { break }

                var cursor = at
                func field(_ width: Int, _ fallback: Int) -> Int {
                    guard width > 0 else { return fallback }
                    var value = 0
                    for _ in 0..<width { value = value * 256 + Int(data[cursor]); cursor += 1 }
                    return value
                }

                let type = field(widths[0], 1)      // /W [0 …] means "type 1 throughout"
                let second = field(widths[1], 0)
                let third = field(widths[2], 0)

                if map[number] != nil { continue }  // a newer section already claimed it
                if type == 1 { map[number] = .atOffset(second, generation: third) }
                else if type == 2 { map[number] = .inObjectStream(number: second, index: third) }
                // type 0 is a free object and is deliberately not recorded.
            }
            pair += 2
        }

        if case .integer(let prev)? = dictionary["Prev"] { return prev }
        return nil
    }

    /// The raw bytes of a stream object, decompressed and un-predicted as `/Filter` says.
    static func streamBytes(
        _ bytes: [UInt8], at offset: Int, text: String, dictionary: [String: PdfValue]
    ) throws -> [UInt8] {
        guard let keyword = text.range(of: "stream") else {
            throw Der.Failure(reason: "xref: object is not a stream")
        }
        var start = offset + text.unicodeScalars.distance(from: text.unicodeScalars.startIndex, to: keyword.upperBound)
        if start < bytes.count && bytes[start] == 0x0d { start += 1 }
        if start < bytes.count && bytes[start] == 0x0a { start += 1 }

        var end = bytes.count
        if case .integer(let length)? = dictionary["Length"] {
            end = min(bytes.count, start + length)
        } else {
            // No /Length: scan for the terminator rather than guessing.
            let body = latin1(bytes[start..<min(bytes.count, start + (1 << 22))])
            if let stop = body.range(of: "endstream") {
                end = start + body.unicodeScalars.distance(from: body.unicodeScalars.startIndex, to: stop.lowerBound)
            }
        }
        guard start <= end else { throw Der.Failure(reason: "xref: negative stream length") }
        let raw = Array(bytes[start..<end])

        var filters: [String] = []
        if case .name(let single)? = dictionary["Filter"] { filters = [single] }
        if case .array(let many)? = dictionary["Filter"] {
            filters = many.compactMap { value in
                if case .name(let n) = value { return n }
                return nil
            }
        }
        if filters.isEmpty { return raw }
        guard filters.allSatisfy({ $0 == "FlateDecode" }) else {
            throw Der.Failure(reason: "xref: unsupported stream filter \(filters.joined(separator: ","))")
        }

        let inflated = try Inflate.inflate(raw)
        guard case .dictionary(let params)? = dictionary["DecodeParms"] else { return inflated }

        func parameter(_ key: String, _ fallback: Int) -> Int {
            for (name, value) in params where name == key {
                if case .integer(let n) = value { return n }
            }
            return fallback
        }
        let predictor = parameter("Predictor", 1)
        if predictor <= 1 { return inflated }

        return try Inflate.undoPredictor(
            inflated, predictor: predictor,
            columns: parameter("Columns", 1),
            colors: parameter("Colors", 1),
            bitsPerComponent: parameter("BitsPerComponent", 8))
    }

    private static func findStartXref(_ bytes: [UInt8]) throws -> Int {
        let tail = latin1(bytes.suffix(2048))
        let matches = startXref.matches(in: tail, range: NSRange(tail.startIndex..., in: tail))
        guard let last = matches.last, let offset = Int(substring(tail, last.range(at: 1))) else {
            throw Der.Failure(reason: "xref: no startxref")
        }
        guard offset > 0 && offset < bytes.count else {
            throw Der.Failure(reason: "xref: startxref \(offset) out of range")
        }
        return offset
    }

    // MARK: - Helpers

    private static let startXref = try! NSRegularExpression(pattern: #"startxref\s+(\d+)"#)
    private static let sectionStart = try! NSRegularExpression(pattern: #"\bxref\b|\d+\s+\d+\s+obj"#)

    private static func starts(_ text: String, with prefix: String) -> Bool {
        text.drop(while: { $0.isWhitespace }).hasPrefix(prefix)
    }

    private static func startsWithObject(_ text: String) -> Bool {
        let head = String(text.prefix(40))
        guard let match = sectionStart.firstMatch(
            in: head, range: NSRange(head.startIndex..., in: head)) else { return false }
        return match.range.location <= 2
    }

    private static func firstSectionStart(_ probe: String) -> String.Index? {
        guard let match = sectionStart.firstMatch(
            in: probe, range: NSRange(probe.startIndex..., in: probe)),
            let range = Range(match.range, in: probe) else { return nil }
        return range.lowerBound
    }

    private static func substring(_ text: String, _ range: NSRange) -> String {
        guard let r = Range(range, in: text) else { return "" }
        return String(text[r])
    }
}

/// Latin-1: every byte maps to one character, so string offsets stay byte offsets.
func latin1<C: Sequence>(_ bytes: C) -> String where C.Element == UInt8 {
    String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) }))
}
