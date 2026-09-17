import Foundation
import PDFCora

/// A sentence in the document that supports an answer (ANS-5).
public struct PdfCitation: Sendable, Equatable {
    public let pageIndex: Int
    /// UTF-16 range in the page's text layer, which is what the core's character indices count.
    public let range: Range<Int>
    public let rects: [PdfRect]
    /// The source text the range covers, not the model's copy of it.
    public let quote: String
}

public enum PdfAnswer: Sendable, Equatable {
    /// `grounded` is false when any quote the model gave could not be found (ANS-3).
    case answered(text: String, citations: [PdfCitation], grounded: Bool, pagesWithoutText: [Int])
    case notFound(pagesWithoutText: [Int])
}

/// What the model is asked to return (ANS-2).
public struct PdfGroundedReply: Sendable, Equatable {
    public struct Citation: Sendable, Equatable {
        public let passage: String
        public let quote: String
        public init(passage: String, quote: String) { self.passage = passage; self.quote = quote }
    }
    public let answer: String
    public let citations: [Citation]
    public init(answer: String, citations: [Citation]) { self.answer = answer; self.citations = citations }
}

enum GroundedAnswers {
    static let maxCitations = 3
    /// Characters per token, deliberately low so a prompt never overruns the budget.
    static let charsPerToken = 3

    static let schema = """
    {"type":"object","properties":{"answer":{"type":"string"},"citations":{"type":"array","maxItems":3,\
    "items":{"type":"object","properties":{"passage":{"type":"string"},"quote":{"type":"string"}},\
    "required":["passage","quote"]}}},"required":["answer","citations"]}
    """

    static func passages(_ index: PdfTextIndex, question: String, contextTokens: Int) -> [PdfPassage] {
        Retrieval.retrieve(index.passages, question: question,
                           budget: Int(Double(contextTokens * charsPerToken) * 0.6))
    }

    static func prompt(question: String, passages: [PdfPassage]) -> String {
        ([
            "Answer the question using only the passages below.",
            "Support the answer with up to \(maxCitations) citations. Each citation names a passage id and",
            "quotes one sentence from that passage word for word.",
            "If the passages do not answer the question, reply with an empty answer and no citations.",
            "",
            "Passages:",
        ] + passages.map {
            // One line per passage: the page's own line breaks would blur where it ends.
            let flat = $0.text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
            return "[\($0.id)] (page \($0.pageIndex + 1)) \(flat)"
        } + ["", "Question: \(question)"]).joined(separator: "\n")
    }

    /// Reads a reply from structured JSON, or from text holding JSON. Nil if neither parses.
    static func parse(structured: String?, text: String) -> PdfGroundedReply? {
        var json = structured ?? text
        json = json.trimmingCharacters(in: .whitespacesAndNewlines)
        if json.hasPrefix("```") {
            json = json.replacingOccurrences(of: "^```(?:json)?\\s*", with: "", options: [.regularExpression, .caseInsensitive])
                .replacingOccurrences(of: "\\s*```$", with: "", options: .regularExpression)
        }
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let answer = object["answer"] as? String,
              let citations = object["citations"] as? [Any] else { return nil }
        return PdfGroundedReply(answer: answer, citations: citations.compactMap {
            guard let c = $0 as? [String: Any], let passage = c["passage"] as? String,
                  let quote = c["quote"] as? String else { return nil }
            return .init(passage: passage, quote: quote)
        }.prefix(maxCitations).map { $0 })
    }

    /// Turns a reply into an answer whose highlights come only from verified quotes.
    ///
    /// A quote is looked for in the passage it names first, then in the other passages the
    /// model was shown, and nowhere else. Apple's on-device model quotes accurately but often
    /// names a passage that does not exist ("p1-3", or a heading), so the quote decides and
    /// the id is only a hint. Coordinates never come from the model.
    ///
    /// With no citations at all there is nothing to verify, so the answer is `notFound`: the
    /// same model replies "not mentioned in the passages" rather than the empty answer asked for.
    static func verify(_ reply: PdfGroundedReply, document: PdfDocument, index: PdfTextIndex,
                       passages: [PdfPassage]) async throws -> PdfAnswer {
        if reply.citations.isEmpty {
            return .notFound(pagesWithoutText: index.pagesWithoutText)
        }
        var citations: [PdfCitation] = []
        var verified = 0
        for cited in reply.citations {
            let candidates = passages.filter { $0.id == cited.passage } + passages.filter { $0.id != cited.passage }
            guard let (passage, found) = candidates.lazy
                .compactMap({ candidate in locateQuote(in: candidate.text, cited.quote).map { (candidate, $0) } })
                .first
            else { continue }
            verified += 1
            let range = (passage.range.lowerBound + found.lowerBound)..<(passage.range.lowerBound + found.upperBound)
            // A model may cite one sentence several times; it is one highlight.
            if citations.contains(where: { $0.pageIndex == passage.pageIndex && $0.range == range }) { continue }
            let page = index.pages.first { $0.pageIndex == passage.pageIndex }!
            citations.append(PdfCitation(
                pageIndex: passage.pageIndex, range: range,
                rects: try await TextLayer.rects(document, pageIndex: passage.pageIndex, range: range),
                quote: NSString(string: page.text).substring(with: NSRange(location: range.lowerBound, length: range.count))))
        }
        return .answered(text: reply.answer, citations: citations,
                         grounded: verified == reply.citations.count,
                         pagesWithoutText: index.pagesWithoutText)
    }
}
