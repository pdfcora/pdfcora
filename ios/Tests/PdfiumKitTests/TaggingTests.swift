import XCTest
@testable import PdfiumKit

/// Mirrors `web/test/tagging.test.ts`.
final class TaggingTests: LicensedTestCase {
    struct Expected: Decodable { let pageIndex: Int; let type: String; let objectCount: Int }

    private func untagged() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Repo.root.appendingPathComponent("conformance/remediation/untagged.pdf")))
    }

    private func expectedBlocks() throws -> [PdfTagBlock] {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Repo.root.appendingPathComponent("conformance/remediation/untagged-expected.json")))
        var next: [Int: Int] = [:]
        return expected.map { b in
            let start = next[b.pageIndex] ?? 0
            next[b.pageIndex] = start + b.objectCount
            return PdfTagBlock(pageIndex: b.pageIndex, type: PdfTagType(rawValue: b.type)!, objectIndices: Array(start..<(start + b.objectCount)))
        }
    }

    private func shape(_ elements: [PdfStructureElement]) -> String {
        elements.map { $0.children.isEmpty ? $0.type : "\($0.type)(\(shape($0.children)))" }.joined(separator: " ")
    }

    func testWritesTheStructureTreeListsIncluded() async throws {
        let document = try await untagged()
        let tagged = try await document.tagContent(try expectedBlocks(), title: "Quarterly newsletter", language: "en-GB")
        let isTagged = try await tagged.isTagged
        XCTAssertTrue(isTagged)
        let originalTagged = try await document.isTagged
        XCTAssertFalse(originalTagged)
        let page0 = try await tagged.page(0).structure()
        XCTAssertEqual(shape(page0), "Document(H1 P H2 L(LI(LBody) LI(LBody) LI(LBody)) P Figure P)")
        let page1 = try await tagged.page(1).structure()
        XCTAssertEqual(shape(page1), "Document(H2 L(LI(LBody) LI(LBody)) P)")
        XCTAssertEqual(page0[0].children[1].markedContentIds, [1, 2])

        let described = try await tagged.updateFigures([PdfFigureEdit(pageIndex: 0, markedContentIds: [8], change: .altText("The Berlin office at dusk"))])
        let out = Repo.root.appendingPathComponent("build/remediation")
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try await described.data().write(to: out.appendingPathComponent("written-ios.pdf"))
    }

    func testAFigureCanBeDescribedWhileTagging() async throws {
        let blocks = try expectedBlocks().map { $0.type == .figure ? PdfTagBlock(pageIndex: $0.pageIndex, type: .figure, objectIndices: $0.objectIndices, altText: "The Berlin office") : $0 }
        let tagged = try await untagged().tagContent(blocks, title: "T", language: "en")
        let figure = try await tagged.page(0).structure()[0].children.first { $0.type == "Figure" }
        XCTAssertEqual(figure?.altText, "The Berlin office")
    }

    func testRefusesWhatItCannotWrite() async throws {
        let document = try await untagged()
        let blocks = try expectedBlocks()
        func refuses(_ blocks: [PdfTagBlock], title: String? = "T", language: String? = "en", _ message: String) async {
            do {
                _ = try await document.tagContent(blocks, title: title, language: language)
                XCTFail("expected invalidOperation: \(message)")
            } catch PdfError.invalidOperation {
            } catch {
                XCTFail("\(message): \(error)")
            }
        }
        await refuses(blocks + [PdfTagBlock(pageIndex: 0, type: .p, objectIndices: [0])], "listed twice")
        await refuses([PdfTagBlock(pageIndex: 0, type: .p, objectIndices: [99])], "out of range")
        await refuses([PdfTagBlock(pageIndex: 0, type: .p, objectIndices: [0], altText: "x")], "alt on a paragraph")
        await refuses(blocks, title: nil, "no title")
        await refuses(blocks, language: nil, "no language")
        let tagged = try await document.tagContent(blocks, title: "T", language: "en")
        do {
            _ = try await tagged.tagContent(blocks, title: "T", language: "en")
            XCTFail("expected already tagged")
        } catch PdfError.invalidOperation {
        }
    }

    func testATrialDocumentWritesAWatermarkedResult() async throws {
        PdfLicense.configureForTesting(key: .some(nil))
        defer { LicensedTestCase.installFullTestLicense() }
        let tagged = try await untagged().tagContent(try expectedBlocks(), title: "T", language: "en")
        let needs = await tagged.needsWatermark
        XCTAssertTrue(needs)
        let saved = try await PdfDocument(data: try await tagged.data())
        let text = try await saved.page(0).text.string()
        XCTAssertEqual(text.components(separatedBy: "PdfiumKit trial").count - 1, 1)
    }
}
