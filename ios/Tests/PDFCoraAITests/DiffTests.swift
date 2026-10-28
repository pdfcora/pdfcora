import XCTest
@testable import PDFCora
@testable import PDFCoraAI

/// Mirrors `web-ai/test/diff.test.ts`.
final class DiffTests: XCTestCase {
    static let dir = RedactionPatternTests.root.appendingPathComponent("conformance/diff")
    private func open(_ name: String) async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent(name)))
    }
    private func ai(_ document: PdfDocument, _ provider: PdfAiProvider? = nil) -> PdfAI {
        var options = PdfAIOptions(provider: provider)
        options.allowsOnDevice = false
        return PdfAI(document: document, options: options)
    }

    struct Case: Decodable { let a: String; let b: String; let atLeast: Double?; let below: Double?; let exactly: Double? }
    struct Expected: Decodable, Equatable { let kind: String; let original: String?; let revised: String? }

    final class Provider: PdfAiProvider, @unchecked Sendable {
        let answer: @Sendable (PdfAiRequest, Int) throws -> PdfAiResponse
        private let lock = NSLock()
        private(set) var count = 0
        init(_ answer: @escaping @Sendable (PdfAiRequest, Int) throws -> PdfAiResponse) { self.answer = answer }
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            let n = lock.withLock { count += 1; return count - 1 }
            return try answer(request, n)
        }
    }

    func testSimilarityCases() throws {
        for c in try JSONDecoder().decode([Case].self, from: Data(contentsOf: Self.dir.appendingPathComponent("similarity.json"))) {
            let value = DiffAligner.similarity(c.a, c.b)
            if let atLeast = c.atLeast { XCTAssertGreaterThanOrEqual(value, atLeast, "\(c.a) / \(c.b)") }
            if let below = c.below { XCTAssertLessThan(value, below, "\(c.a) / \(c.b)") }
            if let exactly = c.exactly { XCTAssertEqual(value, exactly, "\(c.a) / \(c.b)") }
        }
    }

    func testWithoutAModelSentencesAlignAsExpected() async throws {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Self.dir.appendingPathComponent("expected.json")))
        let diff = try await ai(try await open("original.pdf")).diff.compare(revised: try await open("revised.pdf"))
        XCTAssertFalse(diff.modelUsed)
        XCTAssertTrue(diff.notice.contains("Check the differences against both documents."))
        XCTAssertEqual(diff.changes.map { Expected(kind: $0.kind.rawValue, original: $0.original?.text, revised: $0.revised?.text) }, expected)
        XCTAssertEqual(diff.changes.map(\.label), [.unclassified, .meaningChanged, .unclassified, .meaningChanged])
        XCTAssertEqual(diff.changes.map(\.id), ["c1", "c2", "c3", "c4"])
        for change in diff.changes { for side in [change.original, change.revised].compactMap({ $0 }) { XCTAssertEqual(side.rects.count, 1, side.text) } }
        XCTAssertEqual(diff.changes[2].original?.pageIndex, 1)
    }

    func testAProviderLabelsRewordedPairs() async throws {
        let provider = Provider { request, _ in
            request.prompt.contains("30 days")
                ? PdfAiResponse(text: "", structured: #"{"label":"meaningChanged","summary":"The notice period doubles to 60 days."}"#)
                : PdfAiResponse(text: #"{"label": "wordingOnly", "summary": ""}"#)
        }
        let diff = try await ai(try await open("original.pdf"), provider).diff.compare(revised: try await open("revised.pdf"))
        XCTAssertEqual(provider.count, 2)
        XCTAssertTrue(diff.modelUsed)
        XCTAssertEqual(diff.changes.map(\.label), [.wordingOnly, .meaningChanged, .meaningChanged, .meaningChanged])
        XCTAssertEqual(diff.changes.map(\.summary), [nil, nil, "The notice period doubles to 60 days.", nil])
        XCTAssertEqual(diff.changes.map(\.source), [.customProvider, .rules, .customProvider, .rules])

        struct Offline: Error {}
        let flaky = Provider { _, n in if n == 0 { return PdfAiResponse(text: #"{"label":"maybe"}"#) }; throw Offline() }
        let unsure = try await ai(try await open("original.pdf"), flaky).diff.compare(revised: try await open("revised.pdf"))
        XCTAssertFalse(unsure.modelUsed)
        XCTAssertEqual(unsure.changes.filter { $0.kind == .modified }.map(\.label), [.unclassified, .unclassified])
    }
}
