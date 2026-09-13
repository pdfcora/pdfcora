import XCTest
@testable import PdfiumKit

/// Mirrors `web/test/writer-*.test.ts` assertion for assertion, so the two
/// implementations are held to one contract.
final class PdfValueTests: XCTestCase {
    private func text(_ value: PdfValue) -> String {
        String(decoding: PdfValue.serialize(value), as: UTF8.self)
    }

    func testNamesRefsNumbersAndBooleans() {
        XCTAssertEqual(text(.name("Sig")), "/Sig")
        XCTAssertEqual(text(.reference(12)), "12 0 R")
        XCTAssertEqual(text(.reference(12, generation: 3)), "12 3 R")
        XCTAssertEqual(text(.integer(42)), "42")
        XCTAssertEqual(text(.real(-1.5)), "-1.5")
        XCTAssertEqual(text(.boolean(true)), "true")
        XCTAssertEqual(text(.null), "null")
    }

    func testArraysAndDictionariesNest() {
        XCTAssertEqual(text(.array([.integer(1), .integer(2), .integer(3)])), "[1 2 3]")
        XCTAssertEqual(text(.dictionary([("Type", .name("Sig")), ("Contents", .reference(4))])),
                       "<</Type /Sig /Contents 4 0 R>>")
    }

    func testStringsEscapeDelimiters() {
        XCTAssertEqual(text(.string("a(b)c\\d")), "(a\\(b\\)c\\\\d)")
    }

    func testNamesEscapeTerminatingCharacters() {
        XCTAssertEqual(text(.name("a b")), "/a#20b")
        XCTAssertEqual(text(.name("a/b")), "/a#2Fb")
    }

    func testNonASCIIStringsUseUTF16BEWithABOM() {
        let out = text(.string("café"))
        XCTAssertTrue(out.hasPrefix("<FEFF"), out)
        XCTAssertTrue(out.hasSuffix(">"))
    }

    /// The /Contents placeholder is patched in place once the byte range is known,
    /// so its serialised width must be exactly predictable.
    func testHexStringsKeepTheirExactByteWidth() {
        XCTAssertEqual(text(.hexString(Data(count: 4))), "<00000000>")
        XCTAssertEqual(PdfValue.serialize(.hexString(Data(count: 4096))).count, 4096 * 2 + 2)
    }

    func testIndirectObjectWrapsItsValue() {
        let bytes = PdfValue.serialize(.dictionary([("X", .integer(1))]), objectNumber: 7)
        XCTAssertEqual(String(decoding: bytes, as: UTF8.self), "7 0 obj\n<</X 1>>\nendobj\n")
    }
}

final class TrailerScanTests: XCTestCase {
    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    private var documents: [String] {
        get throws {
            try FileManager.default.contentsOfDirectory(atPath: Repo.corpus.path)
                .filter { $0.hasSuffix(".pdf") && !$0.hasPrefix("encrypted_") }
                .sorted()
        }
    }

    func testEveryCorpusDocumentScansWhicheverStyleItUses() throws {
        var styles = Set<XrefStyle>()
        for file in try documents {
            let bytes = try read(file)
            let info = try TrailerInfo.scan(bytes)
            XCTAssertTrue(info.startXref > 0 && info.startXref < bytes.count, file)
            XCTAssertGreaterThan(info.size, 0, file)
            styles.insert(info.style)
        }
        XCTAssertEqual(styles, [.table, .stream], "the sweep must exercise both styles")
    }

    func testReportsTheStyleEachDocumentUses() throws {
        XCTAssertEqual(try TrailerInfo.scan(read("hello_world.pdf")).style, .table)
        XCTAssertEqual(try TrailerInfo.scan(read("embedded_attachments.pdf")).style, .stream)
    }

    /// bug_455199.pdf declares /Size 6 while its table lists objects 0-6, and its
    /// startxref points eight bytes before the xref keyword. Trusting either one
    /// overwrites object 6 — the page content stream — and the text silently vanishes.
    func testDoesNotTrustSizeOrAnExactStartXref() throws {
        let info = try TrailerInfo.scan(read("bug_455199.pdf"))
        XCTAssertEqual(info.style, .table, "startxref points early; the style is still a table")
        XCTAssertGreaterThan(info.nextObjectNumber, 6, "must not reuse a live object number")
    }

    func testRefusesAnEncryptedDocument() throws {
        XCTAssertThrowsError(try TrailerInfo.scan(read("encrypted_hello_world_r2.pdf")))
    }

    func testRejectsBytesThatAreNotAPdf() {
        XCTAssertThrowsError(try TrailerInfo.scan(Data([1, 2, 3])))
    }
}

final class IncrementalUpdateTests: XCTestCase {
    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    func testOriginalBytesSurviveAndTheFileOnlyGrows() throws {
        let base = try read("hello_world.pdf")
        let info = try TrailerInfo.scan(base)
        let out = try PdfWriter.appendUpdate(
            to: base, objects: [info.nextObjectNumber: .dictionary([("Type", .name("Unused"))])])
        XCTAssertGreaterThan(out.count, base.count)
        XCTAssertEqual(out.prefix(base.count), base)
    }

    func testUpdateCarriesPrevSoTheOriginalXrefStaysReachable() throws {
        let base = try read("hello_world.pdf")
        let out = try PdfWriter.appendUpdate(to: base, objects: [:])
        let tail = String(decoding: out.dropFirst(base.count), as: UTF8.self)
        XCTAssertTrue(tail.contains("/Prev"), tail)
        XCTAssertTrue(tail.contains("startxref"), tail)
    }

    /// The acceptance criterion for the whole component: PDFium must still open it.
    func testEveryCorpusDocumentStillOpensWithUnchangedContent() async throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: Repo.corpus.path)
            .filter { $0.hasSuffix(".pdf") && !$0.hasPrefix("encrypted_") }
            .sorted()

        for file in files {
            let base = try read(file)
            let before = try await PdfDocument(data: base)
            let pages = await before.pageCount
            let text = try await before.page(0).text.string()

            let info = try TrailerInfo.scan(base)
            let out = try PdfWriter.appendUpdate(
                to: base, objects: [info.nextObjectNumber: .dictionary([("Type", .name("Unused"))])])

            let after = try await PdfDocument(data: out)
            let afterPages = await after.pageCount
            XCTAssertEqual(afterPages, pages, "\(file): page count changed")
            let afterText = try await after.page(0).text.string()
            XCTAssertEqual(afterText, text, "\(file): text changed")
        }
    }

    func testStackedUpdatesEachKeepTheOneBeforeReachable() async throws {
        var bytes = try read("hello_world.pdf")
        let original = try await PdfDocument(data: bytes).page(0).text.string()
        for round in 0..<3 {
            let info = try TrailerInfo.scan(bytes)
            bytes = try PdfWriter.appendUpdate(
                to: bytes, objects: [info.nextObjectNumber: .dictionary([("Round", .integer(round))])])
        }
        let document = try await PdfDocument(data: bytes)
        let pages = await document.pageCount
        XCTAssertEqual(pages, 1)
        let finalText = try await document.page(0).text.string()
        XCTAssertEqual(finalText, original)
    }
}
