import Foundation
import PdfiumKit

public let redactionNotice = "Suggestions may be incomplete. Review the whole document."

public struct PdfRedactionSuggestion: Sendable, Equatable {
    public let id: String
    public let category: PdfRedactionCategory
    public let source: PdfAiSource
    public let pageIndex: Int
    /// UTF-16 offsets into the page text.
    public let range: Range<Int>
    public let text: String
    public let rects: [PdfRect]
}

public enum PdfRedactionError: Error, Equatable { case unknownSuggestion(String) }

public struct PdfRedactionApplied: Sendable {
    public let report: PdfRedactionReport
    /// Accepted suggestions whose text is still on the page. Empty unless something went wrong.
    public let remaining: [PdfRedactionSuggestion]
    let snapshot: PdfDocumentSnapshot
    /// Reopens the document as it was before `apply`. The host shows it and closes the redacted one.
    public func undo() async throws -> PdfDocument { try await snapshot.open() }
}

public struct PdfRedactionReview: Sendable {
    public let suggestions: [PdfRedactionSuggestion]
    /// False when no model answered, so only patterns ran.
    public let modelUsed: Bool
    /// Must be shown with the suggestions (RED-4).
    public let notice: String
    public let pagesWithoutText: [Int]
    let document: PdfDocument
    let textBefore: [Int: String]

    public func apply(accepting acceptedIds: [String]) async throws -> PdfRedactionApplied {
        let known = Set(suggestions.map(\.id))
        if let unknown = acceptedIds.first(where: { !known.contains($0) }) { throw PdfRedactionError.unknownSuggestion(unknown) }
        let accepted = suggestions.filter { acceptedIds.contains($0.id) }

        let snapshot = try await document.snapshot()
        let report = try await document.redact(accepted.flatMap { s in s.rects.map { .region($0, pageIndex: s.pageIndex) } })

        // Offsets move once text is removed, so count occurrences instead.
        var remaining: [PdfRedactionSuggestion] = []
        for pageIndex in Set(accepted.map(\.pageIndex)) {
            let after = try await document.page(pageIndex).text.string()
            let before = textBefore[pageIndex] ?? ""
            let onPage = accepted.filter { $0.pageIndex == pageIndex }
            for text in Set(onPage.map(\.text)) {
                let same = onPage.filter { $0.text == text }
                if RedactionSuggester.occurrences(of: text, in: after).count
                    > RedactionSuggester.occurrences(of: text, in: before).count - same.count {
                    remaining.append(contentsOf: same)
                }
            }
        }
        return PdfRedactionApplied(report: report, remaining: remaining.sorted { $0.id < $1.id }, snapshot: snapshot)
    }
}

enum RedactionSuggester {
    struct Item: Sendable { let category: PdfRedactionCategory; let quote: String }

    static func prompt(_ text: String) -> String {
        [
            "Find personal data in the text below.",
            "Categories: personName (the name of a person, not a company), postalAddress (a street address with a postal code or city),",
            "dateOfBirth (a date the text says is a birth date), idNumber (a passport, national ID, social security or tax number).",
            "Copy each quote exactly as it appears in the text. Reply with JSON: {\"items\": [{\"category\": \"...\", \"quote\": \"...\"}]}.",
            "Reply with {\"items\": []} when there is none.",
            "",
            text,
        ].joined(separator: "\n")
    }

    static let schema = """
    {"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"category":{"type":"string","enum":["personName","postalAddress","dateOfBirth","idNumber"]},"quote":{"type":"string"}},"required":["category","quote"]}}},"required":["items"]}
    """

    static func occurrences(of quote: String, in text: String) -> [Range<Int>] {
        let units = NSString(string: text)
        var found: [Range<Int>] = []
        var offset = 0
        while offset < units.length, let at = locateQuote(in: units.substring(from: offset), quote) {
            found.append((offset + at.lowerBound)..<(offset + at.upperBound))
            offset += at.upperBound
        }
        return found
    }

    static func parse(_ text: String) -> [(category: String, quote: String)] {
        guard let from = text.firstIndex(of: "{"), let to = text.lastIndex(of: "}"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[from...to].utf8)) as? [String: Any],
              let items = object["items"] as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let category = item["category"] as? String, let quote = item["quote"] as? String else { return nil }
            return (category, quote)
        }
    }

    /// Page text in pieces of at most `limit` UTF-16 units, split between sentences.
    static func chunks(_ pages: [PdfPageText], limit: Int) -> [String] {
        var chunks: [String] = []
        for page in pages {
            let units = NSString(string: page.text)
            var current = ""
            for sentence in TextLayer.sentences(of: page.text) {
                let piece = units.substring(with: NSRange(location: sentence.lowerBound, length: sentence.count))
                if !current.isEmpty, (current as NSString).length + (piece as NSString).length + 1 > limit {
                    chunks.append(current)
                    current = ""
                }
                current = current.isEmpty ? String(piece.prefix(limit)) : current + " " + piece
            }
            if !current.isEmpty { chunks.append(current) }
        }
        return chunks
    }

    static func verified(_ reply: String, chunk: String, wanted: Set<PdfRedactionCategory>) -> [Item] {
        parse(reply).compactMap { raw in
            guard let category = PdfRedactionCategory(rawValue: raw.category), PdfRedactionCategory.model.contains(category),
                  wanted.contains(category), raw.quote.trimmingCharacters(in: .whitespaces).count >= 3,
                  locateQuote(in: chunk, raw.quote) != nil else { return nil }
            return Item(category: category, quote: raw.quote)
        }
    }
}

extension PdfiumAI {
    public struct Redactions: Sendable {
        let ai: PdfiumAI

        /// Suggests likely personal data to redact (RED). Patterns run on every device; Apple's
        /// on-device model, or the custom provider, adds names, addresses, dates of birth and
        /// ID numbers. Nothing is written until `apply`.
        public func suggest(pages: ClosedRange<Int>? = nil,
                            categories: Set<PdfRedactionCategory>? = nil) async throws -> PdfRedactionReview {
            let wanted = categories ?? Set(PdfRedactionCategory.allCases)
            let document = ai.document
            let (pageTexts, pagesWithoutText) = try await TextLayer.readPages(document, range: pages)

            var found: [(category: PdfRedactionCategory, source: PdfAiSource, pageIndex: Int, range: Range<Int>)] = []
            for page in pageTexts {
                for match in Patterns.find(in: page.text, categories: wanted.intersection(PdfRedactionCategory.patterns)) {
                    found.append((match.category, .rules, page.pageIndex, match.range))
                }
            }

            var modelUsed = false
            let modelWanted = wanted.intersection(PdfRedactionCategory.model)
            let apple = ai.appleReading()
            let appleTokens = apple?.isPromptable == true ? apple?.contextTokens : nil
            let provider = ai.options.provider
            if !modelWanted.isEmpty, appleTokens != nil || provider != nil {
                func limit(_ tokens: Int) -> Int { Int(Double(tokens * GroundedAnswers.charsPerToken) * 0.6) }
                let outcome: PdfAiOutcome<[RedactionSuggester.Item]> = await resolveRoutes(
                    onDevice: appleTokens.map { tokens in {
                        var items: [RedactionSuggester.Item] = []
                        for chunk in RedactionSuggester.chunks(pageTexts, limit: limit(tokens)) {
                            guard let reply = try await AppleModel.respond(to: RedactionSuggester.prompt(chunk)) else { return nil }
                            items += RedactionSuggester.verified(reply, chunk: chunk, wanted: modelWanted)
                        }
                        return items
                    } },
                    customProvider: provider.map { provider in {
                        var items: [RedactionSuggester.Item] = []
                        for chunk in RedactionSuggester.chunks(pageTexts, limit: limit(ai.options.providerContextTokens)) {
                            let response = try await provider.generate(PdfAiRequest(prompt: RedactionSuggester.prompt(chunk),
                                                                                   schema: RedactionSuggester.schema))
                            items += RedactionSuggester.verified(response.structured ?? response.text, chunk: chunk, wanted: modelWanted)
                        }
                        return items
                    } })
                if case .answered(let result) = outcome {
                    modelUsed = true
                    for item in result.value {
                        for page in pageTexts {
                            for range in RedactionSuggester.occurrences(of: item.quote, in: page.text) {
                                found.append((item.category, result.source, page.pageIndex, range))
                            }
                        }
                    }
                }
            }

            // Patterns are deterministic, so a model suggestion that overlaps one is dropped.
            let kept = found.filter { s in
                s.source == .rules || !found.contains { $0.source == .rules && $0.pageIndex == s.pageIndex && $0.range.overlaps(s.range) }
            }
            var seen = Set<String>()
            let textBefore = Dictionary(uniqueKeysWithValues: pageTexts.map { ($0.pageIndex, $0.text) })
            var suggestions: [PdfRedactionSuggestion] = []
            for s in kept.sorted(by: { ($0.pageIndex, $0.range.lowerBound) < ($1.pageIndex, $1.range.lowerBound) }) {
                let id = "\(s.pageIndex):\(s.range.lowerBound)-\(s.range.upperBound):\(s.category.rawValue)"
                guard seen.insert(id).inserted else { continue }
                let text = NSString(string: textBefore[s.pageIndex]!).substring(with: NSRange(location: s.range.lowerBound, length: s.range.count))
                suggestions.append(PdfRedactionSuggestion(
                    id: id, category: s.category, source: s.source, pageIndex: s.pageIndex, range: s.range, text: text,
                    rects: try await TextLayer.rects(document, pageIndex: s.pageIndex, range: s.range)))
            }
            return PdfRedactionReview(suggestions: suggestions, modelUsed: modelUsed, notice: Trial.text(redactionNotice),
                                      pagesWithoutText: pagesWithoutText, document: document, textBefore: textBefore)
        }
    }

    /// Suggests likely personal data to redact (RED).
    public var redactions: Redactions { Redactions(ai: self) }
}
