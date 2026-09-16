import XCTest
@testable import PdfiumKit
@testable import PdfiumKitAI

/// Mirrors `web-ai/test/remediation.test.ts`.
final class RemediationTests: LicensedTestCase {
    static let dir = RedactionPatternTests.root.appendingPathComponent("conformance/remediation")
    struct Expected: Decodable, Equatable { let pageIndex: Int; let type: String; let objectCount: Int; let text: String }

    private func untagged() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent("untagged.pdf")))
    }
    private func types(_ elements: [PdfStructureElement]) -> [String] { elements.flatMap { [$0.type] + types($0.children) } }

    func testTheRulesProposeExactlyTheExpectedBlocks() async throws {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Self.dir.appendingPathComponent("untagged-expected.json")))
        let review = try await PdfiumAI(document: try await untagged()).remediation.suggest()
        XCTAssertFalse(review.alreadyTagged)
        XCTAssertTrue(review.notice.contains("Check every tag and the reading order before they are written."))
        XCTAssertEqual(review.blocks.map { Expected(pageIndex: $0.pageIndex, type: $0.type.rawValue, objectCount: $0.objectIndices.count, text: $0.text) }, expected)
        XCTAssertEqual(review.blocks.map(\.order), Array(1...expected.count))
        for block in review.blocks { XCTAssertEqual(block.id, "\(block.pageIndex):\(block.objectIndices[0])") }
    }

    /// PDF/UA 7.4.2. Real documents often set a late line larger than the first heading;
    /// by size alone this document would start at H2 and skip to H3.
    func testHeadingLevelsStartAtH1AndNeverSkip() async throws {
        let expected = try JSONDecoder().decode([Expected].self,
            from: Data(contentsOf: Self.dir.appendingPathComponent("heading-order-expected.json")))
        let document = try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent("heading-order.pdf")))
        let review = try await PdfiumAI(document: document).remediation.suggest()
        XCTAssertEqual(review.blocks.map { $0.type.rawValue }, expected.map(\.type))
    }

    func testApplyTagsWithOverrides() async throws {
        let document = try await untagged()
        let review = try await PdfiumAI(document: document).remediation.suggest()
        let caption = try XCTUnwrap(review.blocks.first { $0.text.hasPrefix("Figure 1") })
        let tagged = try await review.apply(types: [caption.id: .h3], language: "en-GB")
        let page0 = try await tagged.page(0).structure()
        XCTAssertEqual(types(page0), ["Document", "H1", "P", "H2", "L", "LI", "LBody", "LI", "LBody", "LI", "LBody", "P", "Figure", "H3"])
        let original = try await document.isTagged
        XCTAssertFalse(original)
    }

    func testUnknownOverridesThrowAndTaggedDocumentsAreNotProposedFor() async throws {
        let review = try await PdfiumAI(document: try await untagged()).remediation.suggest()
        do { _ = try await review.apply(types: ["9:9": .p], language: "en"); XCTFail() } catch PdfProposalError.unknownProposal {}
        let tagged = try await review.apply(language: "en")
        let again = try await PdfiumAI(document: tagged).remediation.suggest()
        XCTAssertTrue(again.alreadyTagged)
        XCTAssertEqual(again.blocks, [])
    }
}
