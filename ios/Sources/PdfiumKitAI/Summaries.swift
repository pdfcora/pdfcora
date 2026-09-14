import Foundation

public enum PdfSummaryStyle: Sendable, Equatable {
    case paragraph, keyPoints
}

public struct PdfSummary: Sendable, Equatable {
    public let text: String
    public let pagesWithoutText: [Int]
}

enum SummaryText {
    /// Summarises text of any length with a summariser that accepts at most `limit` UTF-16
    /// units at a time (SUM-2). Pages are packed into parts that fit, each part is
    /// summarised, and the summaries are combined the same way until one call covers
    /// everything.
    static func summarise(_ pages: [String], limit: Int,
                          _ summarise: (String) async throws -> String) async throws -> String {
        var parts = pack(pages.flatMap { split($0, limit: limit) }, limit: limit)
        guard !parts.isEmpty else { return "" }
        while parts.count > 1 {
            var summaries: [String] = []
            for part in parts { summaries.append(try await summarise(part)) }
            let next = pack(summaries.flatMap { split($0, limit: limit) }, limit: limit)
            // Summaries that no longer shrink would loop forever.
            if next.joined().utf16.count >= parts.joined().utf16.count {
                parts = [String(next.joined(separator: "\n\n").utf16.prefix(limit)) ?? ""]
                break
            }
            parts = next
        }
        return try await summarise(parts[0])
    }

    private static func pack(_ pieces: [String], limit: Int) -> [String] {
        var parts: [String] = []
        var current = ""
        for piece in pieces {
            let joined = current.isEmpty ? piece : current + "\n\n" + piece
            if joined.utf16.count <= limit {
                current = joined
            } else {
                if !current.isEmpty { parts.append(current) }
                current = piece
            }
        }
        if !current.isEmpty { parts.append(current) }
        return parts
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
