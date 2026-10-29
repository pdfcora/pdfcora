import XCTest
@testable import PDFCora

final class XfdfImportTests: XCTestCase {
    private func fixture(_ path: String) throws -> Data {
        try Data(contentsOf: Repo.root.appendingPathComponent("conformance/\(path)"))
    }

    private func text(_ path: String) throws -> String {
        try String(contentsOf: Repo.root.appendingPathComponent("conformance/\(path)"), encoding: .utf8)
    }

    private func blank() async throws -> PdfDocument { try await PdfDocument(data: fixture("xfdf/source-blank.pdf")) }

    private func isInvalid(_ error: Error) -> Bool {
        if case .invalidOperation = error as? PdfError { return true }
        return false
    }

    func testImportsConformanceFile() async throws {
        let report = try await blank().importXFDF(text("xfdf/import.xfdf"))
        let expected = try JSONSerialization.jsonObject(with: fixture("xfdf/expected-import.json")) as! [String: Any]
        let want = expected["report"] as! [String: Any]
        XCTAssertEqual(report.fieldsSet, want["fieldsSet"] as? Int)
        XCTAssertEqual(report.annotationsAdded, want["annotationsAdded"] as? Int)
        let skipped = (want["skipped"] as! [[String: Any]]).map {
            PdfXfdfSkip(element: $0["element"] as! String, page: $0["page"] as? Int,
                        reason: PdfXfdfSkipReason(rawValue: $0["reason"] as! String)!)
        }
        XCTAssertEqual(report.skipped, skipped)
    }

    func testExportsWhatWasImported() async throws {
        let document = try await blank()
        _ = try await document.importXFDF(text("xfdf/import.xfdf"))
        let exported = try await document.exportXFDF()
        XCTAssertEqual(exported, try text("xfdf/expected-after-import.xfdf"))
    }

    func testRejectsDoctype() async throws {
        let document = try await blank()
        let before = try await document.exportXFDF()
        do { _ = try await document.importXFDF(text("xfdf/doctype.xfdf")); XCTFail("accepted a DOCTYPE") }
        catch { XCTAssertTrue(isInvalid(error), "\(error)") }
        let after = try await document.exportXFDF()
        XCTAssertEqual(after, before)
    }

    func testRejectsMalformed() async throws {
        let document = try await blank()
        let before = try await document.exportXFDF()
        for bad in [try text("xfdf/malformed.xfdf"), "<notxfdf/>"] {
            do { _ = try await document.importXFDF(bad); XCTFail("accepted \(bad.prefix(20))") }
            catch { XCTAssertTrue(isInvalid(error), "\(error)") }
        }
        let after = try await document.exportXFDF()
        XCTAssertEqual(after, before)
    }

    func testRejectsOversizedInput() async throws {
        let document = try await blank()
        do { _ = try await document.importXFDF(String(repeating: "a", count: 10_485_761)); XCTFail("accepted 10 MiB + 1") }
        catch { XCTAssertTrue(isInvalid(error), "\(error)") }
    }

    func testImportingTwiceAddsTwice() async throws {
        let document = try await blank()
        let xfdf = try text("xfdf/import.xfdf")
        let first = try await document.importXFDF(xfdf)
        let second = try await document.importXFDF(xfdf)
        XCTAssertEqual(first.annotationsAdded, 5)
        XCTAssertEqual(second.annotationsAdded, 5)
        let inks = try await document.page(0).annotations().filter { if case .ink = $0 { return true } else { return false } }
        XCTAssertEqual(inks.count, 2)
    }

    func testSavedDocumentKeepsAuthorAndDates() async throws {
        let document = try await blank()
        _ = try await document.importXFDF(text("xfdf/import.xfdf"))
        let reopened = try await PdfDocument(data: document.data(mode: .full))
        let xfdf = try await reopened.exportXFDF()
        XCTAssertTrue(xfdf.contains("title=\"Imported &amp; signed\""))
        XCTAssertTrue(xfdf.contains("date=\"D:20261030100000Z\""))
        XCTAssertTrue(xfdf.contains("name=\"imp-ink\""))
    }

    func testEdgeCasesRoundTrip() async throws {
        let document = try await blank()
        let report = try await document.importXFDF(text("xfdf/edge.xfdf"))
        XCTAssertEqual(report.annotationsAdded, 2)
        let exported = try await document.exportXFDF()
        XCTAssertEqual(exported, try text("xfdf/expected-edge-export.xfdf"))
        let again = try await blank()
        _ = try await again.importXFDF(exported)
        let reExported = try await again.exportXFDF()
        XCTAssertEqual(reExported, exported)
    }

    func testRejectsDeepNesting() async throws {
        let deep = "<xfdf><fields>" + String(repeating: "<field name=\"a\">", count: 300)
            + String(repeating: "</field>", count: 300) + "</fields></xfdf>"
        do { _ = try await blank().importXFDF(deep); XCTFail("accepted deep nesting") }
        catch { XCTAssertTrue(isInvalid(error), "\(error)") }
    }

    func testRejectsADoctypeHiddenByAnotherEncoding() async throws {
        let utf7 = "<?xml version=\"1.0\" encoding=\"UTF-7\"?>+ADw-+ACE-DOCTYPE x +AFs-+ADw-+ACE-ENTITY s SYSTEM +ACI-file:///etc/hosts+ACI-+AD4-+AF0-+AD4-<xfdf/>"
        do { _ = try await blank().importXFDF(utf7); XCTFail("accepted a hidden DOCTYPE") }
        catch { XCTAssertTrue(isInvalid(error), "\(error)") }
    }
}
