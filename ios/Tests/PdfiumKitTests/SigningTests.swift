import Compression
import XCTest
@testable import PdfiumKit

/// Mirrors `web/test/{xref,read-object,sign-field,sign}.test.ts`.
///
/// The gate is `pdfsig`, not our own verifier: ours agreeing with our own signer would
/// prove nothing, since they would share any bug.
final class XrefTests: LicensedTestCase {
    private func read(_ name: String) throws -> [UInt8] {
        [UInt8](try Data(contentsOf: Repo.corpus.appendingPathComponent(name)))
    }

    private var documents: [String] {
        get throws {
            try FileManager.default.contentsOfDirectory(atPath: Repo.corpus.path)
                .filter { $0.hasSuffix(".pdf") && !$0.hasPrefix("encrypted_") }
                .sorted()
        }
    }

    func testInflateRoundTrips() throws {
        // A tiny fixed zlib stream, so the test does not depend on a compressor.
        let original = Array("stream contents ".utf8)
        let compressed = try deflate(original)
        XCTAssertEqual(try Inflate.inflate(compressed), original)
    }

    func testLocatesEveryObjectInAClassicTable() throws {
        // hello_world.pdf's table declares "0 7", so objects 1..6 exist.
        let xref = try Xref.build(try read("hello_world.pdf"))
        for number in 1...6 { XCTAssertNotNil(xref[number], "object \(number)") }
    }

    func testLocatesAnObjectInsideAnObjectStream() throws {
        let xref = try Xref.build(try read("bug_707673.pdf"))
        let compressed = xref.values.filter { if case .inObjectStream = $0 { return true }; return false }
        XCTAssertFalse(compressed.isEmpty, "this file must exercise the object-stream path")
    }

    /// The whole corpus, because a subset missed a precedence bug on the web side: only
    /// documents whose startxref sits late in a big file failed.
    func testEveryCorpusDocumentYieldsANonEmptyMap() throws {
        let files = try documents
        XCTAssertGreaterThanOrEqual(files.count, 19, "the sweep must cover the corpus")
        for file in files {
            XCTAssertFalse(try Xref.build(try read(file)).isEmpty, file)
        }
    }

    /// Cross-reference streams are routinely PNG-predicted. Inflating without undoing it
    /// yields plausible bytes and completely wrong offsets.
    func testReadsACatalogBehindAPredictedXrefStream() throws {
        for file in ["annotation_stamp_with_ap.pdf", "embedded_attachments.pdf",
                     "signed_unh_iol.pdf"] {
            let (_, value) = try PdfReader.catalog(try read(file))
            XCTAssertTrue(PdfReader.isName(try XCTUnwrap(PdfReader.entry(value, "Type")), "Catalog"), file)
        }
    }

    func testEveryCorpusDocumentYieldsItsCatalog() throws {
        for file in try documents {
            let (_, value) = try PdfReader.catalog(try read(file))
            XCTAssertTrue(PdfReader.isName(try XCTUnwrap(PdfReader.entry(value, "Type")), "Catalog"), file)
        }
    }

    /// `/AcroForm` may be inline or a reference, and real files use both.
    func testReadsAnAcroFormWhetherInlineOrAReference() throws {
        let bytes = try read("text_form.pdf")
        let (_, catalog) = try PdfReader.catalog(bytes)
        let xref = try Xref.build(bytes)

        let acroForm = PdfReader.reference(catalog, "AcroForm").flatMap {
            PdfReader.object(bytes, xref, $0)
        } ?? PdfReader.entry(catalog, "AcroForm")

        XCTAssertNotNil(acroForm, "text_form.pdf has an AcroForm")
        XCTAssertNotNil(PdfReader.entry(try XCTUnwrap(acroForm), "Fields"))
    }

    /// Deflates with Compression, only so the inflate test has an input.
    private func deflate(_ bytes: [UInt8]) throws -> [UInt8] {
        let capacity = bytes.count * 2 + 64
        var out = [UInt8](repeating: 0, count: capacity)
        let written = bytes.withUnsafeBufferPointer { source in
            out.withUnsafeMutableBufferPointer { destination in
                compression_encode_buffer(destination.baseAddress!, capacity,
                                          source.baseAddress!, bytes.count, nil, COMPRESSION_ZLIB)
            }
        }
        return Array(out.prefix(written))
    }
}

final class SignatureFieldTests: LicensedTestCase {
    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    func testTheDocumentStillOpensAndKeepsItsContent() async throws {
        let base = try read("hello_world.pdf")
        let original = try await PdfDocument(data: base)
        let before = try await original.page(0).text.string()

        let placed = try SignatureField.place(in: base, options: .init())
        let after = try await PdfDocument(data: Data(placed.bytes))
        let pages = await after.pageCount
        XCTAssertEqual(pages, 1)
        let afterText = try await after.page(0).text.string()
        XCTAssertEqual(afterText, before)
    }

    func testPdfiumSeesASignatureWhereThereWasNone() async throws {
        let base = try read("hello_world.pdf")
        let placed = try SignatureField.place(in: base, options: .init())
        let document = try await PdfDocument(data: Data(placed.bytes))
        let signatures = try await document.signatures()
        XCTAssertEqual(signatures.first?.subFilter, "ETSI.CAdES.detached")
    }

    /// Off by one byte here and the signature protects the wrong span.
    func testTheByteRangeBracketsThePlaceholderExactly() throws {
        let placed = try SignatureField.place(in: try read("hello_world.pdf"), options: .init())
        XCTAssertEqual(placed.byteRange[0], 0)
        XCTAssertEqual(placed.byteRange[1], placed.contentsAt)
        XCTAssertEqual(placed.byteRange[2], placed.contentsAt + placed.contentsLength)
        XCTAssertEqual(placed.byteRange[2] + placed.byteRange[3], placed.bytes.count)
    }

    func testAnExistingAcroFormIsExtendedNotReplaced() async throws {
        let base = try read("text_form.pdf")
        let original = try await PdfDocument(data: base)
        let before = try await original.page(0).formFields().count
        XCTAssertGreaterThan(before, 0)

        let placed = try SignatureField.place(in: base, options: .init())
        let document = try await PdfDocument(data: Data(placed.bytes))
        let after = try await document.page(0).formFields().count
        XCTAssertEqual(after, before + 1, "the original fields must survive")
    }
}

final class SigningTests: LicensedTestCase {
    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    private func signer() throws -> Pkcs12Signer {
        let p12 = try Data(contentsOf: Repo.root
            .appendingPathComponent("conformance/fixtures/test-signer.p12"))
        return try Pkcs12Signer(pkcs12: p12, password: "pdfiumkit")
    }

    private var anchor: Data {
        get throws {
            try Data(contentsOf: Repo.root
                .appendingPathComponent("conformance/fixtures/test-signer.der"))
        }
    }

    func testASignedDocumentVerifiesWithOurOwnVerifier() async throws {
        let signed = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try signer(), reason: "Approved"))

        let document = try await PdfDocument(data: signed)
        let signatures = try await document.signatures()
        let signature = try XCTUnwrap(signatures.first)
        XCTAssertTrue(signature.coversWholeDocument)

        let verdict = await document.verify(
            signature, options: PdfVerifyOptions(trustAnchors: [try anchor]))
        guard case .valid = verdict else { return XCTFail("expected valid, got \(verdict)") }
    }

    /// The real gate is `pdfsig`, but an iOS test cannot spawn a process — Foundation's
    /// Process is macOS-only. So the signed document is written where the host can reach
    /// it, and `scripts/test-ios.sh` runs pdfsig over it after the suite. A test that
    /// only asked our own verifier would prove nothing, since signer and verifier share
    /// any bug.
    func testWritesASignedDocumentForTheHostToCrossCheck() async throws {
        let signed = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try signer()))

        let path = URL(fileURLWithPath: "/tmp/pdfiumkit-ios-signed.pdf")
        try signed.write(to: path)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path.path),
                      "the host cross-check needs this file")
    }

    func testTamperingIsDetected() async throws {
        var signed = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try signer()))
        signed[100] ^= 0xff

        let document = try await PdfDocument(data: signed)
        let signatures = try await document.signatures()
        let verdict = await document.verify(
            try XCTUnwrap(signatures.first),
            options: PdfVerifyOptions(trustAnchors: [try anchor]))
        XCTAssertEqual(verdict, .digestMismatch)
    }

    /// Self-signed, so it is cryptographically sound and untrusted at once.
    func testWithoutAnAnchorOurOwnSignatureIsUntrusted() async throws {
        let signed = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try signer()))
        let document = try await PdfDocument(data: signed)
        let signatures = try await document.signatures()
        let verdict = await document.verify(try XCTUnwrap(signatures.first))
        guard case .untrusted = verdict else { return XCTFail("expected untrusted, got \(verdict)") }
    }

    /// The property the append-only writer exists for.
    func testSigningTwiceLeavesTheFirstSignatureIntact() async throws {
        let once = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try signer()))
        let twice = try await PdfDocument(data: once)
            .sign(PdfSignOptions(signer: try signer()))

        let document = try await PdfDocument(data: twice)
        let signatures = try await document.signatures()
        XCTAssertEqual(signatures.count, 2)
        XCTAssertFalse(signatures[0].coversWholeDocument, "the first no longer covers all")
        XCTAssertTrue(signatures[1].coversWholeDocument)

        for signature in signatures {
            let verdict = await document.verify(
                signature, options: PdfVerifyOptions(trustAnchors: [try anchor]))
            guard case .valid = verdict else {
                return XCTFail("signature \(signature.index): \(verdict)")
            }
        }
    }

    /// Too small a placeholder must fail loudly; silent truncation corrupts the file.
    func testASignatureThatWillNotFitIsRefused() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        do {
            _ = try await document.sign(PdfSignOptions(signer: try signer(), reservedBytes: 64))
            XCTFail("expected the signature not to fit")
        } catch let error as PdfError {
            XCTAssertTrue("\(error)".contains("reserved"), "\(error)")
        }
    }
}

/// The signing contract, asserted identically on all three platforms.
///
/// Web supplies its own CMS implementation while iOS and Android build one natively, so
/// the mechanism differs — but the properties a signed document must have do not, and
/// that is what this pins.
final class SigningContractTests: LicensedTestCase {
    func testASignedDocumentMeetsTheContract() async throws {
        let base = try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf"))
        let p12 = try Data(contentsOf: Repo.root
            .appendingPathComponent("conformance/fixtures/test-signer.p12"))
        let anchor = try Data(contentsOf: Repo.root
            .appendingPathComponent("conformance/fixtures/test-signer.der"))

        let original = try await PdfDocument(data: base)
        let before = try await original.page(0).text.string()

        let signed = try await PdfDocument(data: base).sign(
            PdfSignOptions(signer: try Pkcs12Signer(pkcs12: p12, password: "pdfiumkit")))
        let document = try await PdfDocument(data: signed)

        let signatures = try await document.signatures()
        XCTAssertEqual(signatures.count, 1, "exactly one signature")
        XCTAssertEqual(signatures[0].subFilter, "ETSI.CAdES.detached")
        XCTAssertTrue(signatures[0].coversWholeDocument)

        let trusted = await document.verify(
            signatures[0], options: PdfVerifyOptions(trustAnchors: [anchor]))
        guard case .valid = trusted else { return XCTFail("expected valid, got \(trusted)") }

        // Self-signed, so without the anchor it is sound but untrusted — never valid.
        let untrusted = await document.verify(signatures[0])
        guard case .untrusted = untrusted else {
            return XCTFail("expected untrusted, got \(untrusted)")
        }

        // The content must survive signing untouched.
        let after = try await document.page(0).text.string()
        XCTAssertEqual(after, before)
    }
}
