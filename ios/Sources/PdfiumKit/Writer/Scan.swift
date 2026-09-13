import Foundation

public enum XrefStyle: Sendable { case table, stream }

/// Reading just enough of an existing PDF to append to it.
///
/// Deliberately not a parser. To write an incremental update we need where the last
/// cross-reference section starts, which style it uses, the next free object number,
/// and the trailer entries to carry forward. Nothing else.
public struct TrailerInfo: Sendable {
    public let startXref: Int
    public let style: XrefStyle
    public let size: Int
    /// Highest object number actually present, which `/Size` may understate.
    public let highestObject: Int
    public let root: PdfValue
    public let info: PdfValue?
    public let id: PdfValue?

    /// Where the next object this writer adds should be numbered.
    ///
    /// Not simply `size`: real files disagree with their own trailer. `bug_455199.pdf`
    /// declares `/Size 6` while its table lists objects 0-6, so trusting it overwrites a
    /// live object — in that file, the page content stream.
    public var nextObjectNumber: Int { max(size, highestObject + 1) }

    public static func scan(_ bytes: Data) throws -> TrailerInfo {
        let startXref = try findStartXref(bytes)
        let (entries, style) = try readTrailerDictionary(bytes, at: startXref)

        if entries["Encrypt"] != nil {
            // Strings in appended objects would have to be encrypted with the document
            // key. Writing them in the clear produces a file that opens and then shows
            // mojibake, which is worse than refusing.
            throw PdfError.saveFailed(reason: "cannot append to an encrypted document")
        }
        guard case .integer(let size)? = entries["Size"] else {
            throw PdfError.saveFailed(reason: "trailer has no /Size")
        }
        guard let root = entries["Root"] else {
            throw PdfError.saveFailed(reason: "trailer has no /Root")
        }

        return TrailerInfo(
            startXref: startXref, style: style, size: size,
            highestObject: highestObjectNumber(bytes, size: size),
            root: root, info: entries["Info"], id: entries["ID"])
    }

    /// Scans for `N G obj` headers, the only account of object numbers that cannot
    /// disagree with itself. Objects inside object streams are invisible here, which is
    /// why `/Size` still participates in the maximum.
    private static func highestObjectNumber(_ bytes: Data, size: Int) -> Int {
        let text = latin1(bytes)
        var highest = size - 1
        for match in Self.objectHeader.matches(in: text, range: text.fullRange) {
            if let number = plausible(text.substring(match.range(at: 1))) {
                highest = max(highest, number)
            }
        }
        for match in Self.subsection.matches(in: text, range: text.fullRange) {
            if let first = plausible(text.substring(match.range(at: 1))),
               let count = plausible(text.substring(match.range(at: 2))) {
                highest = max(highest, first + count - 1)
            }
        }
        return highest
    }

    /// The scan runs over the whole file, binary stream data included, so it finds byte
    /// sequences that merely look like object headers. The spec caps object numbers at
    /// 8,388,607; anything above that is a false match, not a document with ten million
    /// objects.
    private static func plausible(_ digits: String) -> Int? {
        guard let value = Int(digits), value >= 0, value <= 8_388_607 else { return nil }
        return value
    }

    private static let objectHeader = try! NSRegularExpression(pattern: #"(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b"#)
    private static let subsection = try! NSRegularExpression(pattern: #"\bxref\s*\n\s*(\d+)\s+(\d+)"#)
    private static let sectionStart = try! NSRegularExpression(pattern: #"\bxref\b|<<"#)

    private static func findStartXref(_ bytes: Data) throws -> Int {
        // The spec allows junk after %%EOF, so search backwards from the end.
        let tail = latin1(bytes.suffix(2048))
        let pattern = try! NSRegularExpression(pattern: #"startxref\s+(\d+)"#)
        guard let last = pattern.matches(in: tail, range: tail.fullRange).last,
              let offset = Int(tail.substring(last.range(at: 1))) else {
            throw PdfError.saveFailed(reason: "no startxref: not a PDF, or truncated")
        }
        guard offset > 0 && offset < bytes.count else {
            throw PdfError.saveFailed(reason: "startxref \(offset) is out of range")
        }
        return offset
    }

    private static func readTrailerDictionary(
        _ bytes: Data, at offset: Int
    ) throws -> ([String: PdfValue], XrefStyle) {
        let end = min(bytes.count, offset + 65536)
        var window = latin1(bytes[bytes.startIndex.advanced(by: offset)..<bytes.startIndex.advanced(by: end)])

        // startxref is not always exact. bug_455199.pdf points eight bytes early, into
        // the preceding "endobj". PDFium tolerates it, so this must too.
        if !window.hasPrefixIgnoringSpace("xref") && !window.hasPrefixIgnoringSpace("<<") {
            // Whichever comes first, and "xref" only as a whole word: the trailing
            // "startxref" contains it, and matching there routes an xref-stream file
            // down the table branch.
            let probe = String(window.prefix(512))
            if let match = Self.sectionStart.firstMatch(
                in: probe, range: NSRange(probe.startIndex..., in: probe)),
               let range = Range(match.range, in: probe) {
                window = String(window[range.lowerBound...])
            }
        }

        if window.hasPrefixIgnoringSpace("xref") {
            guard let trailerAt = window.range(of: "trailer"),
                  let dictAt = window.range(of: "<<", range: trailerAt.upperBound..<window.endIndex) else {
                throw PdfError.saveFailed(reason: "xref table has no trailer")
            }
            return (try PdfDictionaryReader(window).read(from: dictAt.lowerBound), .table)
        }
        guard let dictAt = window.range(of: "<<") else {
            throw PdfError.saveFailed(reason: "no dictionary at startxref \(offset)")
        }
        return (try PdfDictionaryReader(window).read(from: dictAt.lowerBound), .stream)
    }
}

/// Latin-1 rather than UTF-8: every byte maps to exactly one character, so string
/// offsets stay byte offsets and no sequence is rejected as invalid.
private func latin1<C: Sequence>(_ bytes: C) -> String where C.Element == UInt8 {
    String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) }))
}

private extension String {
    var fullRange: NSRange { NSRange(startIndex..., in: self) }
    func substring(_ range: NSRange) -> String {
        guard let r = Range(range, in: self) else { return "" }
        return String(self[r])
    }
    func hasPrefixIgnoringSpace(_ prefix: String) -> Bool {
        drop(while: { $0.isWhitespace }).hasPrefix(prefix)
    }
}
