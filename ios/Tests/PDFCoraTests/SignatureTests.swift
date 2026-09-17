import XCTest
@testable import PDFCora

/**
 Mirrors `web/test/signatures.test.ts`.

 Expectations come from `pdfsig`, not from this SDK, so a bug here cannot be confirmed
 by a matching bug in our own reader:

     Signer Certificate Common Name: UNH-IOL
     Signing Time: Jan 05 2026 16:23:15
     Signature Type: adbe.pkcs7.detached
     Signed Ranges: [0 - 151484], [156392 - 297957]
     Total document signed
 */
final class SignatureTests: LicensedTestCase {
    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    func testReadsTheSignatureOfARealSignedDocument() async throws {
        let document = try await PdfDocument(data: try read("signed_unh_iol.pdf"))
        let signatures = try await document.signatures()

        XCTAssertEqual(signatures.count, 1)
        let signature = try XCTUnwrap(signatures.first)
        XCTAssertEqual(signature.subFilter, "adbe.pkcs7.detached")
        XCTAssertEqual(signature.byteRange, [0, 151484, 156392, 141565])
        XCTAssertGreaterThan(signature.contents.count, 0, "the PKCS#7 blob must come back")
    }

    func testReportsTheSigningTimeTheSignerClaimed() async throws {
        let document = try await PdfDocument(data: try read("signed_unh_iol.pdf"))
        let signatures = try await document.signatures()
        let signature = try XCTUnwrap(signatures.first)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parts = calendar.dateComponents(
            [.year, .month, .day], from: try XCTUnwrap(signature.signingTime))
        XCTAssertEqual(parts.year, 2026)
        XCTAssertEqual(parts.month, 1)
        XCTAssertEqual(parts.day, 5)
    }

    func testAnUnsignedDocumentReportsNoSignatures() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let signatures = try await document.signatures()
        XCTAssertTrue(signatures.isEmpty)
    }

    /// pdfsig says "Total document signed": the last byte range span ends at EOF.
    func testReportsThatTheSignatureCoversTheWholeFile() async throws {
        let document = try await PdfDocument(data: try read("signed_unh_iol.pdf"))
        let signatures = try await document.signatures()
        let signature = try XCTUnwrap(signatures.first)
        XCTAssertTrue(signature.coversWholeDocument)
    }

    /// Computed, not read, and getting it wrong is the failure that lets a signed
    /// document be silently amended.
    func testASignatureThatStopsShortOfEOFIsNotReportedAsCoveringIt() async throws {
        let base = try read("signed_unh_iol.pdf")
        let info = try TrailerInfo.scan(base)
        // Amend the document after it was signed, exactly as an attacker would.
        let amended = try PdfWriter.appendUpdate(
            to: base,
            objects: [info.nextObjectNumber: .dictionary([("Type", .name("Unused"))])])

        let document = try await PdfDocument(data: amended)
        let signatures = try await document.signatures()
        let signature = try XCTUnwrap(
            signatures.first,
            "the signature must still be found after the amendment")
        XCTAssertFalse(signature.coversWholeDocument,
                       "content was appended after the signed range")
    }
}
