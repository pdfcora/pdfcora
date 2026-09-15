import XCTest
@testable import PdfiumKit
@testable import PdfiumKitAI

final class AltTextTests: LicensedTestCase {
    static let dir = RedactionPatternTests.root.appendingPathComponent("conformance/alt-text")

    struct Expected: Decodable {
        struct Figure: Decodable { let pageIndex: Int; let markedContentIds: [Int]; let kind: String; let caption: String? }
        struct WithAlt: Decodable { let altText: String }
        let figuresWithoutAlt: [Figure]
        let figuresWithAlt: [WithAlt]
    }

    private let expected = try! JSONDecoder().decode(Expected.self, from: Data(contentsOf: dir.appendingPathComponent("tagged-expected.json")))

    private func tagged() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent("tagged.pdf")))
    }
    private func ai(_ document: PdfDocument, _ provider: PdfAiProvider? = nil) -> PdfiumAI {
        var options = PdfiumAIOptions(provider: provider)
        options.allowsOnDevice = false
        return PdfiumAI(document: document, options: options)
    }
    private func figures(_ document: PdfDocument, _ page: Int) async throws -> [PdfStructureElement] {
        func flatten(_ e: [PdfStructureElement]) -> [PdfStructureElement] { e.flatMap { [$0] + flatten($0.children) } }
        return flatten(try await document.page(page).structure()).filter { $0.type == "Figure" }
    }

    final class Provider: PdfAiProvider, @unchecked Sendable {
        let answer: @Sendable (PdfAiRequest, Int) throws -> PdfAiResponse
        private let lock = NSLock()
        private(set) var requests: [PdfAiRequest] = []
        init(_ answer: @escaping @Sendable (PdfAiRequest, Int) throws -> PdfAiResponse) { self.answer = answer }
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            let n = lock.withLock { requests.append(request); return requests.count - 1 }
            return try answer(request, n)
        }
    }

    func testWithoutAModelTheFiguresAreListedAndTheRuleIsDecorative() async throws {
        let review = try await ai(try await tagged()).altText.suggest()
        XCTAssertFalse(review.untagged)
        XCTAssertFalse(review.modelUsed)
        XCTAssertTrue(review.notice.contains("Check every description before it is written."))
        XCTAssertEqual(review.items.map(\.pageIndex), expected.figuresWithoutAlt.map(\.pageIndex))
        XCTAssertEqual(review.items.map(\.markedContentIds), expected.figuresWithoutAlt.map(\.markedContentIds))
        XCTAssertEqual(review.items.map { $0.kind == .decorative ? "decorative" : "description" }, expected.figuresWithoutAlt.map(\.kind))
        for (item, figure) in zip(review.items, expected.figuresWithoutAlt) {
            XCTAssertEqual(item.id, "\(item.pageIndex):\(item.markedContentIds.map(String.init).joined(separator: ","))")
            XCTAssertEqual(item.text, "")
            XCTAssertEqual(item.source, item.kind == .decorative ? .rules : nil)
            if let caption = figure.caption { XCTAssertTrue(item.context.contains(caption), item.context) }
        }
    }

    func testAProviderGetsOnePngPerDescribedFigure() async throws {
        let provider = Provider { request, _ in
            let logo = request.prompt.contains("company logo")
            return PdfAiResponse(text: #"{"decorative":false,"description":"\#(logo ? "Red circle logo" : "Office building at dusk")"}"#)
        }
        let review = try await ai(try await tagged(), provider).altText.suggest()
        XCTAssertEqual(provider.requests.count, 2)
        for request in provider.requests {
            XCTAssertEqual(request.images.count, 1)
            XCTAssertEqual([UInt8](request.images[0].prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
            XCTAssertNotNil(UIImage(data: request.images[0]))
        }
        XCTAssertTrue(review.modelUsed)
        XCTAssertEqual(review.items.map(\.text), ["Office building at dusk", "", "Red circle logo"])
        XCTAssertEqual(review.items.map(\.source), [.customProvider, .rules, .customProvider])
    }

    func testDecorativeAnswersAreHonouredAndAThrowingProviderLeavesTextEmpty() async throws {
        struct Offline: Error {}
        let provider = Provider { _, n in
            if n == 0 { return PdfAiResponse(text: "", structured: #"{"decorative":true,"description":""}"#) }
            throw Offline()
        }
        let review = try await ai(try await tagged(), provider).altText.suggest()
        XCTAssertEqual(review.items.map(\.kind), [.decorative, .decorative, .description])
        XCTAssertEqual(review.items.map(\.source), [.customProvider, .rules, nil])
    }

    func testApplyWritesProposedAndEditedDecisions() async throws {
        let provider = Provider { _, _ in PdfAiResponse(text: #"{"decorative":false,"description":"Office building"}"#) }
        let review = try await ai(try await tagged(), provider).altText.suggest()
        let updated = try await review.apply([
            PdfAltTextDecision(id: review.items[0].id), PdfAltTextDecision(id: review.items[1].id),
            PdfAltTextDecision(id: review.items[2].id, text: "Company logo"),
        ])
        let page0 = try await figures(updated, 0)
        XCTAssertEqual(page0.map(\.altText), [expected.figuresWithAlt[0].altText, "Office building"])
        let page1 = try await figures(updated, 1)
        XCTAssertEqual(page1.map(\.altText), ["Company logo"])
        let again = try await ai(updated).altText.suggest()
        XCTAssertEqual(again.items.count, 0)
    }

    func testApplyRefusesUnknownIdsAndMissingDescriptions() async throws {
        let review = try await ai(try await tagged()).altText.suggest()
        do { _ = try await review.apply([PdfAltTextDecision(id: "9:9")]); XCTFail() } catch PdfProposalError.unknownProposal {}
        do { _ = try await review.apply([PdfAltTextDecision(id: review.items[0].id)]); XCTFail() } catch PdfProposalError.missingDescription {}
    }

    func testAnUntaggedDocumentIsReported() async throws {
        let document = try await PdfDocument(data: try Data(contentsOf: RedactionPatternTests.root.appendingPathComponent("conformance/corpus/hello_world.pdf")))
        let review = try await ai(document).altText.suggest()
        XCTAssertTrue(review.untagged)
        XCTAssertEqual(review.items, [])
    }
}
