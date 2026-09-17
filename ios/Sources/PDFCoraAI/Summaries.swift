import Foundation

public enum PdfSummaryStyle: Sendable, Equatable {
    case paragraph, keyPoints
}

public struct PdfSummary: Sendable, Equatable {
    public let text: String
    public let pagesWithoutText: [Int]
}

enum SummaryText {
    private static let earlier = "Summary of the earlier parts:\n"
    private static let next = "\n\nNext part:\n"

    /// Summarises text of any length with a summariser that accepts at most `limit` UTF-16
    /// units at a time (SUM-2), reading it in windows.
    ///
    /// The first window is plain text. Each later window carries the summary so far followed
    /// by the next stretch of text, so each part is summarised knowing what came before, and
    /// the last summary covers the whole document. Text is split at sentences into pieces of
    /// at most a quarter of the limit, and a summary that would leave no room for a piece is
    /// condensed first — and cut, if condensing does not shrink it enough.
    static func summariseInWindows(_ pages: [String], limit: Int,
                                   _ summarise: (String) async throws -> String) async throws -> String {
        let pieceLength = max(1, limit / 4)
        let pieces = pages.flatMap { split($0, limit: pieceLength) }
        let labels = earlier.utf16.count + next.utf16.count
        var summary: String?
        var index = 0

        while index < pieces.count {
            if let current = summary, labels + current.utf16.count + pieceLength > limit {
                let condensed = collapseBullets(try await summarise(prefix(current, limit)))
                summary = prefix(condensed, max(0, limit - labels - pieceLength))
            }
            let room = limit - (summary.map { labels + $0.utf16.count } ?? 0)
            var window = ""
            while index < pieces.count {
                let joined = window.isEmpty ? pieces[index] : window + "\n\n" + pieces[index]
                if joined.utf16.count > room { break }
                window = joined
                index += 1
            }
            summary = collapseBullets(try await summarise(summary.map { earlier + $0 + next + window } ?? window))
        }
        return summary ?? ""
    }

    /// Given a bulleted summary to carry forward, a model may bullet its lines again: Apple's
    /// returns "- - point". Two or more markers opening a line become one.
    private static let repeatedBullets = try! NSRegularExpression(
        pattern: #"^[ \t]*(?:[-*•][ \t]+){2,}"#, options: .anchorsMatchLines)

    private static func collapseBullets(_ text: String) -> String {
        repeatedBullets.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "- ")
    }

    private static func prefix(_ text: String, _ length: Int) -> String {
        let units = NSString(string: text)
        return units.length <= length ? text : units.substring(to: length)
    }

    private static func split(_ text: String, limit: Int) -> [String] {
        let units = NSString(string: text)
        if units.length <= limit {
            return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [text]
        }
        var pieces: [String] = []
        for sentence in TextLayer.sentences(of: text) {
            var at = sentence.lowerBound
            while at < sentence.upperBound {
                let end = min(sentence.upperBound, at + limit)
                pieces.append(units.substring(with: NSRange(location: at, length: end - at)))
                at = end
            }
        }
        return pieces
    }

    static func prompt(_ text: String, style: PdfSummaryStyle) -> String {
        [
            style == .keyPoints
                ? "Summarise the text below as key points, one per line, each starting with \"- \"."
                : "Summarise the text below as one short paragraph.",
            "Use only what the text says.",
            "",
            text,
        ].joined(separator: "\n")
    }
}
