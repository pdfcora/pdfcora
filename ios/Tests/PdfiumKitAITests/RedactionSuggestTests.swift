import XCTest
@testable import PdfiumKit
@testable import PdfiumKitAI

final class RedactionSuggestTests: LicensedTestCase {
    struct Expected: Decodable, Equatable { let pageIndex: Int; let category: String; let text: String }
    static let dir = RedactionPatternTests.root.appendingPathComponent("conformance/redaction")

    private func pii() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent("pii.pdf")))
    }
    private func ai(_ document: PdfDocument, _ provider: PdfAiProvider? = nil) -> PdfiumAI {
        var options = PdfiumAIOptions(provider: provider)
        options.allowsOnDevice = false
        return PdfiumAI(document: document, options: options)
    }

    struct Items: PdfAiProvider {
        let items: [[String: String]]
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            let json = String(data: try JSONSerialization.data(withJSONObject: ["items": items]), encoding: .utf8)!
            return PdfAiResponse(text: "", structured: json)
        }
    }
    struct Failing: PdfAiProvider {
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse { throw URLError(.notConnectedToInternet) }
    }

    func testPatternsAloneFindExactlyTheExpectedItems() async throws {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Self.dir.appendingPathComponent("pii-expected.json")))
        let review = try await ai(try await pii()).redactions.suggest()
        XCTAssertFalse(review.modelUsed)
        XCTAssertTrue(review.notice.contains("Suggestions may be incomplete. Review the whole document."))
        XCTAssertEqual(review.suggestions.map { Expected(pageIndex: $0.pageIndex, category: $0.category.rawValue, text: $0.text) }, expected)
        for s in review.suggestions {
            XCTAssertEqual(s.source, .rules)
            XCTAssertEqual(s.id, "\(s.pageIndex):\(s.range.lowerBound)-\(s.range.upperBound):\(s.category.rawValue)")
            XCTAssertFalse(s.rects.isEmpty, s.text)
        }
    }

    func testModelQuotesAreVerifiedExpandedAndNeverOverlapAPattern() async throws {
        let provider = Items(items: [["category": "personName", "quote": "Anna Schmidt"],
                                     ["category": "personName", "quote": "Nobody Invented"],
                                     ["category": "dateOfBirth", "quote": "14 March 1985"],
                                     ["category": "idNumber", "quote": "Li"],
                                     ["category": "bankBalance", "quote": "Customer record"]])
        let review = try await ai(try await pii(), provider).redactions.suggest(pages: 0...0)
        XCTAssertTrue(review.modelUsed)
        let fromModel = review.suggestions.filter { $0.source == .customProvider }.map { [$0.category.rawValue, $0.text] }
        XCTAssertEqual(fromModel, [["personName", "Anna Schmidt"], ["personName", "Anna Schmidt"]])
    }

    func testAFailingModelLeavesThePatterns() async throws {
        let review = try await ai(try await pii(), Failing()).redactions.suggest()
        XCTAssertFalse(review.modelUsed)
        XCTAssertEqual(review.suggestions.count, 25)
    }

    func testApplyRemovesAcceptedTextKeepsRejectedAndUndoRestores() async throws {
        let document = try await pii()
        let review = try await ai(document).redactions.suggest(pages: 0...0)
        let email = try XCTUnwrap(review.suggestions.first { $0.category == .email })
        let iban = try XCTUnwrap(review.suggestions.first { $0.category == .iban })

        let applied = try await review.apply(accepting: [email.id])
        XCTAssertEqual(applied.remaining, [])
        let saved = try await PdfDocument(data: try await document.data(mode: .full))
        let text = try await saved.page(0).text.string()
        XCTAssertFalse(text.contains(email.text))
        XCTAssertTrue(text.contains(iban.text))
        XCTAssertTrue(text.contains("Email"))

        let restored = try await applied.undo()
        let back = try await restored.page(0).text.string()
        XCTAssertTrue(back.contains(email.text))
    }

    func testAnUnknownIdWritesNothing() async throws {
        let document = try await pii()
        let review = try await ai(document).redactions.suggest()
        let first = review.suggestions[0]
        do {
            _ = try await review.apply(accepting: [first.id, "nope"])
            XCTFail("expected a throw")
        } catch PdfRedactionError.unknownSuggestion(let id) {
            XCTAssertEqual(id, "nope")
        }
        let text = try await document.page(0).text.string()
        XCTAssertTrue(text.contains(first.text))
    }
}
