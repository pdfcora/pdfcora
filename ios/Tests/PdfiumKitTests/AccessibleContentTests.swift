import XCTest
@testable import PdfiumKit

/// Mirrors `web/test/accessible.test.ts`.
final class AccessibleContentTests: LicensedTestCase {
    private func open(_ path: String) async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Repo.root.appendingPathComponent("conformance/\(path)")))
    }
    private func brief(_ nodes: [PdfAccessibleNode]) -> [String] {
        nodes.map { $0.children.isEmpty ? "\($0.role.rawValue)\($0.level.map(String.init) ?? ""):\($0.text)" : "\($0.role.rawValue)[\(brief($0.children).joined(separator: "|"))]" }
    }

    func testATaggedPageReadsInOrder() async throws {
        let document = try await open("alt-text/tagged.pdf")
        let nodes = try await document.page(0).accessibleContent()
        XCTAssertEqual(brief(nodes), [
            "heading1:Annual report 2026",
            "paragraph:Revenue grew in every region this year.",
            "figure:Bar chart of revenue by region",
            "paragraph:Figure 1: Revenue by region.",
            "figure:",
            "paragraph:Figure 2: The new office building in Berlin at dusk.",
            "figure:",
            "paragraph:Staff numbers rose to 120 people.",
        ])
        let page1 = try await document.page(1).accessibleContent()
        XCTAssertEqual(page1.first?.level, 2)
    }

    func testListsNestTheirItems() async throws {
        struct Expected: Decodable { let pageIndex: Int; let type: String; let objectCount: Int }
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Repo.root.appendingPathComponent("conformance/remediation/untagged-expected.json")))
        var next: [Int: Int] = [:]
        let blocks = expected.map { b -> PdfTagBlock in
            let start = next[b.pageIndex] ?? 0
            next[b.pageIndex] = start + b.objectCount
            return PdfTagBlock(pageIndex: b.pageIndex, type: PdfTagType(rawValue: b.type)!, objectIndices: Array(start..<(start + b.objectCount)))
        }
        let tagged = try await open("remediation/untagged.pdf").tagContent(blocks, title: "T", language: "en")
        let nodes = try await tagged.page(0).accessibleContent()
        XCTAssertEqual(Array(brief(nodes).prefix(5)), [
            "heading1:Quarterly newsletter",
            "paragraph:Welcome to the autumn issue. This quarter we opened two offices and welcomed forty new colleagues.",
            "heading2:Highlights",
            "list[listItem:• A new office in Berlin|listItem:• A new office in Madrid|listItem:• The staff survey results]",
            "paragraph:The photo below shows the Berlin office.",
        ])
    }

    func testAnUntaggedPageIsOneParagraphAndFormFieldsFollow() async throws {
        let hello = try await open("corpus/hello_world.pdf").page(0).accessibleContent()
        XCTAssertEqual(hello.count, 1)
        XCTAssertEqual(hello.first?.role, .paragraph)
        XCTAssertTrue(hello.first?.text.contains("Hello, world!") ?? false)
        let form = try await open("corpus/text_form.pdf").page(0).accessibleContent()
        XCTAssertEqual(form.filter { $0.role == .formField }.map(\.text), ["Text Box"])
    }
}
