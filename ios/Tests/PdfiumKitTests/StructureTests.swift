import XCTest
@testable import PdfiumKit

final class StructureTests: LicensedTestCase {
    private var tagged: Data {
        get throws { try Data(contentsOf: Repo.root.appendingPathComponent("conformance/alt-text/tagged.pdf")) }
    }
    private let edits = [
        PdfFigureEdit(pageIndex: 0, markedContentIds: [4], change: .altText("A photo of an office building at dusk")),
        PdfFigureEdit(pageIndex: 0, markedContentIds: [6], change: .decorative),
        PdfFigureEdit(pageIndex: 1, markedContentIds: [2], change: .altText("Company logo: a red circle (é)")),
    ]

    private func flatten(_ elements: [PdfStructureElement]) -> [PdfStructureElement] {
        elements.flatMap { [$0] + flatten($0.children) }
    }

    private func figures(_ document: PdfDocument, _ page: Int) async throws -> [PdfStructureElement] {
        flatten(try await document.page(page).structure()).filter { $0.type == "Figure" }
    }

    func testReadsTheTaggedTestDocument() async throws {
        let document = try await PdfDocument(data: try tagged)
        let tagged = try await document.isTagged
        XCTAssertTrue(tagged)
        let roots = try await document.page(0).structure()
        XCTAssertEqual(roots.map(\.type), ["Document"])
        XCTAssertEqual(roots[0].children.map(\.type), ["H1", "P", "Figure", "P", "Figure", "P", "Figure", "P"])
        XCTAssertEqual(roots[0].children.map(\.markedContentIds), (0...7).map { [$0] })

        let page0 = try await figures(document, 0)
        XCTAssertEqual(page0[0].altText, "Bar chart of revenue by region")
        XCTAssertNil(page0[1].altText)
        XCTAssertEqual(page0[1].bounds, PdfRect(left: 72, bottom: 300, right: 288, top: 444))
        XCTAssertEqual(try XCTUnwrap(page0[2].bounds).top - page0[2].bounds!.bottom, 2, accuracy: 0.01)
        let page1 = try await figures(document, 1)
        XCTAssertEqual(page1[0].markedContentIds, [2])
    }

    func testAnUntaggedDocumentHasNoStructure() async throws {
        let document = try await PdfDocument(data: try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf")))
        let tagged = try await document.isTagged
        XCTAssertFalse(tagged)
        let roots = try await document.page(0).structure()
        XCTAssertEqual(roots, [])
    }

    func testWritesDescriptionsAndDecorativeIntoANewDocument() async throws {
        let document = try await PdfDocument(data: try tagged)
        let updated = try await document.updateFigures(edits)

        let page0 = try await figures(updated, 0)
        XCTAssertEqual(page0.map(\.altText), ["Bar chart of revenue by region", "A photo of an office building at dusk"])
        let page1 = try await figures(updated, 1)
        XCTAssertEqual(page1.map(\.altText), ["Company logo: a red circle (é)"])
        let original = try await figures(document, 0)
        XCTAssertEqual(original.count, 3, "the original keeps every figure")

        let out = Repo.root.appendingPathComponent("build/alt-text")
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try await updated.data().write(to: out.appendingPathComponent("written-ios.pdf"))
    }

    func testDescriptionOnlyEditsAreAnIncrementalUpdate() async throws {
        let original = try tagged
        let updated = try await PdfDocument(data: original).updateFigures([edits[0]])
        let bytes = try await updated.data(mode: .incremental)
        XCTAssertEqual(bytes.prefix(original.count), original)
    }

    func testAFigureInAnObjectStreamOfASignedFileIsRewrittenAndStillVerifies() async throws {
        let document = try await PdfDocument(data: try Data(contentsOf: Repo.corpus.appendingPathComponent("signed_unh_iol.pdf")))
        let updated = try await document.updateFigures([PdfFigureEdit(pageIndex: 0, markedContentIds: [27], change: .altText("UNH-IOL logo"))])
        let figure = try await figures(updated, 0)
        XCTAssertEqual(figure.first?.altText, "UNH-IOL logo")
        let signatures = try await updated.signatures()
        let signature = try XCTUnwrap(signatures.first)
        guard case .untrusted = await updated.verify(signature) else { return XCTFail("the signature no longer verifies") }
    }

    func testAnEditNamingNoFigureWritesNothing() async throws {
        let document = try await PdfDocument(data: try tagged)
        for wrong in [PdfFigureEdit(pageIndex: 0, markedContentIds: [99], change: .altText("x")),
                      PdfFigureEdit(pageIndex: 0, markedContentIds: [1], change: .altText("x"))] {
            do {
                _ = try await document.updateFigures([edits[0], wrong])
                XCTFail("expected invalidOperation")
            } catch PdfError.invalidOperation {
            }
        }
        do {
            _ = try await document.updateFigures([PdfFigureEdit(pageIndex: 5, markedContentIds: [4], change: .altText("x"))])
            XCTFail("expected pageOutOfRange")
        } catch PdfError.pageOutOfRange {
        }
    }

    func testStringsInARewrittenElementSurvive() throws {
        let source = "<</T (a \\(b\\) c\\\\ \u{e9}) /Lang <FEFF0064>>>"
        let value = try PdfDictionaryReader(source).read(from: source.startIndex)
        let written = latin1([UInt8](PdfValue.serialize(.dictionary([("T", value["T"]!)]))))
        XCTAssertEqual(written, "<</T (a \\(b\\) c\\\\ \u{e9})>>")
        XCTAssertEqual(latin1([UInt8](PdfValue.serialize(value["Lang"]!))), "<FEFF0064>")
    }

    func testATrialDocumentWritesAWatermarkedResult() async throws {
        PdfLicense.configureForTesting(key: .some(nil))
        defer { LicensedTestCase.installFullTestLicense() }
        let updated = try await PdfDocument(data: try tagged).updateFigures([edits[0]])
        let needs = await updated.needsWatermark
        XCTAssertTrue(needs)
        let saved = try await PdfDocument(data: try await updated.data())
        let text = try await saved.page(0).text.string()
        XCTAssertEqual(text.components(separatedBy: "PdfiumKit trial").count - 1, 1)
    }
}
