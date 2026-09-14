import Foundation
import PdfiumKit

/// One page's text layer. Offsets into `text` are UTF-16, which is what the core's
/// character indices count.
public struct PdfPageText: Sendable, Equatable {
    public let pageIndex: Int
    public let text: String
}

/// A retrievable piece of a page: whole sentences, with their UTF-16 range.
public struct PdfPassage: Sendable, Equatable {
    public let id: String
    public let pageIndex: Int
    public let range: Range<Int>
    public let text: String
}

public struct PdfTextIndex: Sendable {
    public let pages: [PdfPageText]
    public let passages: [PdfPassage]
    /// Pages with no text layer, which could not be searched (ANS-6).
    public let pagesWithoutText: [Int]
}

/// Passages are whole sentences up to about this many UTF-16 units.
private let passageLength = 600

enum TextLayer {
    /// Reads each page's text layer. Pages whose text is only whitespace count as having none.
    static func readPages(_ document: PdfDocument, range: ClosedRange<Int>? = nil) async throws
        -> (pages: [PdfPageText], pagesWithoutText: [Int]) {
        let count = await document.pageCount
        guard count > 0 else { return ([], []) }
        let from = max(0, range?.lowerBound ?? 0)
        let to = min(count - 1, range?.upperBound ?? count - 1)
        var pages: [PdfPageText] = []
        var pagesWithoutText: [Int] = []
        guard from <= to else { return ([], []) }
        for pageIndex in from...to {
            let text = try await document.page(pageIndex).text.string()
            if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                pagesWithoutText.append(pageIndex)
            } else {
                pages.append(PdfPageText(pageIndex: pageIndex, text: text))
            }
        }
        return (pages, pagesWithoutText)
    }

    static func index(_ document: PdfDocument) async throws -> PdfTextIndex {
        let (pages, pagesWithoutText) = try await readPages(document)
        return PdfTextIndex(pages: pages, passages: pages.flatMap(passages(of:)),
                            pagesWithoutText: pagesWithoutText)
    }

    /// Splits a page into sentence-aligned passages, keeping each one's range.
    static func passages(of page: PdfPageText) -> [PdfPassage] {
        let units = NSString(string: page.text)
        var passages: [PdfPassage] = []
        var current: Range<Int>?
        func flush() {
            guard let range = current else { return }
            passages.append(PdfPassage(
                id: "p\(page.pageIndex)-\(passages.count)", pageIndex: page.pageIndex, range: range,
                text: units.substring(with: NSRange(location: range.lowerBound, length: range.count))))
            current = nil
        }
        for sentence in sentences(of: page.text) {
            if let open = current, sentence.upperBound - open.lowerBound > passageLength { flush() }
            current = (current?.lowerBound ?? sentence.lowerBound)..<sentence.upperBound
        }
        flush()
        return passages
    }

    /// Sentence ranges in UTF-16 units, trimmed of surrounding whitespace.
    static func sentences(of text: String) -> [Range<Int>] {
        let units = NSString(string: text)
        let boundary = try! NSRegularExpression(pattern: "[.!?](?=\\s|$)|\\n\\s*\\n")
        var ranges: [Range<Int>] = []
        var cursor = 0
        func push(_ from: Int, _ to: Int) {
            var from = from, to = to
            while from < to, isSpace(units.character(at: from)) { from += 1 }
            while to > from, isSpace(units.character(at: to - 1)) { to -= 1 }
            if to > from { ranges.append(from..<to) }
        }
        for match in boundary.matches(in: text, range: NSRange(location: 0, length: units.length)) {
            let to = match.range.location + match.range.length
            push(cursor, to)
            cursor = to
        }
        push(cursor, units.length)
        return ranges
    }

    static func isSpace(_ unit: UInt16) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return CharacterSet.whitespacesAndNewlines.contains(scalar)
    }

    /// Rectangles covering a character range, one per line, from the core's per-character
    /// boxes. Characters PDFium generates for layout have empty boxes and are skipped.
    static func rects(_ document: PdfDocument, pageIndex: Int, range: Range<Int>) async throws -> [PdfRect] {
        let text = try await document.page(pageIndex).text
        var rects: [PdfRect] = []
        for index in range {
            let box = try await text.boundingBox(ofCharacterAt: index)
            guard box.right > box.left, box.top > box.bottom else { continue }
            if let line = rects.last, sameLine(line, box) {
                rects[rects.count - 1] = PdfRect(left: min(line.left, box.left), bottom: min(line.bottom, box.bottom),
                                                 right: max(line.right, box.right), top: max(line.top, box.top))
            } else {
                rects.append(box)
            }
        }
        return rects
    }

    private static func sameLine(_ a: PdfRect, _ b: PdfRect) -> Bool {
        let overlap = min(a.top, b.top) - max(a.bottom, b.bottom)
        return overlap > 0.5 * min(a.top - a.bottom, b.top - b.bottom) && b.left >= a.left - 1
    }
}
