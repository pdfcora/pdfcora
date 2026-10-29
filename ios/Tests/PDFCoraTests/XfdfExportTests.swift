import XCTest
@testable import PDFCora

final class XfdfExportTests: XCTestCase {
    private func fixture(_ path: String) throws -> Data {
        try Data(contentsOf: Repo.root.appendingPathComponent("conformance/\(path)"))
    }

    private func text(_ path: String) throws -> String {
        try String(contentsOf: Repo.root.appendingPathComponent("conformance/\(path)"), encoding: .utf8)
    }

    func testExportsConformanceDocumentExactly() async throws {
        let document = try await PdfDocument(data: fixture("xfdf/source.pdf"))
        let exported = try await document.exportXFDF()
        XCTAssertEqual(exported, try text("xfdf/expected-export.xfdf"))
    }

    func testExportEscapesAndKeepsUnicode() async throws {
        let xfdf = try await PdfDocument(data: fixture("xfdf/source.pdf")).exportXFDF()
        XCTAssertTrue(xfdf.contains("<value>Zoë &amp; \"Co\" &lt;ok&gt;</value>"))
        XCTAssertTrue(xfdf.contains("title=\"Zoë &amp; &quot;Co&quot; &lt;ok&gt;\""))
        XCTAssertTrue(xfdf.contains("<contents>A note &amp; a &lt;tag&gt;</contents>"))
    }

    func testExportsEmptyDocument() async throws {
        let xfdf = try await PdfDocument(data: fixture("corpus/hello_world.pdf")).exportXFDF()
        XCTAssertEqual(xfdf, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">\n</xfdf>\n")
    }

    func testFormatNumber() {
        XCTAssertEqual(Xfdf.format(1.23456), "1.2346")
        XCTAssertEqual(Xfdf.format(2.5), "2.5")
        XCTAssertEqual(Xfdf.format(-0.0), "0")
        XCTAssertEqual(Xfdf.format(-0.00001), "0")
        XCTAssertEqual(Xfdf.format(72), "72")
        XCTAssertEqual(Xfdf.format(72.03125), "72.0313")
        XCTAssertEqual(Xfdf.format(-72.03125), "-72.0313")
    }

    func testParserRejectsDoctype() {
        XCTAssertThrowsError(try Xfdf.parse("<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><x>&e;</x>"))
        XCTAssertThrowsError(try Xfdf.parse("<x>&nbsp;</x>"))
        XCTAssertThrowsError(try Xfdf.parse("<x><y></x>"))
        let root = try? Xfdf.parse("<a x=\"1&amp;2\"><b>t&lt;&#233;</b></a>")
        XCTAssertEqual(root?.attributes["x"], "1&2")
        XCTAssertEqual(root?.children.first?.text, "t<é")
    }
}
