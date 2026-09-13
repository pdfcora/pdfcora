import XCTest
@testable import PdfiumKit

/**
 Mirrors `web/test/{der,signed-data,verify-digest,verify}.test.ts`.

 `pdfsig` reports both of these about the fixture, at the same time:

     Signature Validation:   Signature is Valid.
     Certificate Validation: Certificate issuer is unknown.

 Integrity and trust are separate answers. Collapsing them into one is the defect this
 whole phase exists to avoid, so it is the first test.
 */
final class DerTests: XCTestCase {
    func testReadsAShortFormTlv() throws {
        let bytes: [UInt8] = [0x30, 0x03, 0x02, 0x01, 0x01]   // SEQUENCE { INTEGER 1 }
        let tlv = try Der.readTlv(bytes, 0)
        XCTAssertEqual(tlv.tag, 0x30)
        XCTAssertEqual(tlv.length, 3)
        XCTAssertEqual(tlv.end, 5)
        XCTAssertEqual(try Der.children(bytes, tlv).count, 1)
    }

    func testReadsLongFormLengths() throws {
        var bytes: [UInt8] = [0x04, 0x82, 0x01, 0x2c]         // 300-byte OCTET STRING
        bytes.append(contentsOf: [UInt8](repeating: 0, count: 300))
        XCTAssertEqual(try Der.readTlv(bytes, 0).length, 300)
    }

    func testDecodesAnOid() throws {
        let bytes: [UInt8] = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]
        XCTAssertEqual(try Der.readOid(bytes, try Der.readTlv(bytes, 0)), "1.2.840.113549.1.9.4")
    }

    /// The 2.x branch encodes differently from 1.x, because the first octet packs
    /// two arcs as 40 * first + second.
    func testDecodesTheSha256Oid() throws {
        let bytes: [UInt8] = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]
        XCTAssertEqual(try Der.readOid(bytes, try Der.readTlv(bytes, 0)), "2.16.840.1.101.3.4.2.1")
    }

    func testRefusesALengthPastTheBuffer() {
        XCTAssertThrowsError(try Der.readTlv([0x30, 0x7f], 0))
    }

    func testRefusesAnIndefiniteLength() {
        XCTAssertThrowsError(try Der.readTlv([0x30, 0x80, 0x00, 0x00], 0))
    }

    func testRefusesAnEmptyBuffer() {
        XCTAssertThrowsError(try Der.readTlv([], 0))
    }
}

final class CmsSignedDataTests: XCTestCase {
    private var pkcs7: [UInt8] = []

    override func setUp() async throws {
        let bytes = try Data(contentsOf: Repo.corpus.appendingPathComponent("signed_unh_iol.pdf"))
        let document = try await PdfDocument(data: bytes)
        let signatures = try await document.signatures()
        pkcs7 = [UInt8](try XCTUnwrap(signatures.first).contents)
    }

    /// Compared byte for byte against what OpenSSL extracts from the same blob, so the
    /// certificate boundaries are confirmed by a tool that does not share our parser.
    func testExtractsTheCertificateExactlyAsOpenSSLDoes() throws {
        let cms = try CmsSignedData.parse(pkcs7)
        XCTAssertEqual(cms.certificates.count, 1)

        let reference = try Data(contentsOf: Repo.root
            .appendingPathComponent("conformance/fixtures/unh-iol-signer.der"))
        XCTAssertEqual(Data(cms.certificates[0]), reference)
    }

    func testExtractsTheAlgorithms() throws {
        let cms = try CmsSignedData.parse(pkcs7)
        XCTAssertEqual(cms.digestAlgorithm, "2.16.840.1.101.3.4.2.1")       // sha256
        XCTAssertEqual(cms.signatureAlgorithm, "1.2.840.113549.1.1.11")     // sha256WithRSA
    }

    func testExtractsTheSignerSerial() throws {
        let serial = try CmsSignedData.parse(pkcs7).signerSerial
        XCTAssertEqual(serial.map { String(format: "%02X", $0) }.joined(), "4BB35DB9A6994675E459")
    }

    func testExtractsTheMessageDigestAttribute() throws {
        let digest = try XCTUnwrap(try CmsSignedData.parse(pkcs7).messageDigest)
        XCTAssertEqual(digest.count, 32)
        XCTAssertEqual(digest.map { String(format: "%02X", $0) }.joined(),
                       "9F9DF165ED1A251D0644F7DE9B1BC1C71328D4F139209F1BD28336E9D1FEFD73")
    }

    /// The signature is computed over the SET encoding, not the `[0] IMPLICIT` form the
    /// file stores. Returning the stored bytes makes every signature appear invalid.
    func testSignedAttributesAreRetaggedAsASet() throws {
        let attrs = try XCTUnwrap(try CmsSignedData.parse(pkcs7).signedAttrs)
        XCTAssertEqual(attrs[0], 0x31, "must be SET (0x31), not [0] IMPLICIT (0xa0)")
        XCTAssertEqual(attrs.count, 94)
    }

    func testRejectsABlobThatIsNotSignedData() {
        XCTAssertThrowsError(try CmsSignedData.parse([0x30, 0x03, 0x02, 0x01, 0x01]))
    }
}

final class VerificationTests: XCTestCase {
    private var bytes = Data()
    private var document: PdfDocument!
    private var signature: PdfSignature!
    private var anchor = Data()

    override func setUp() async throws {
        bytes = try Data(contentsOf: Repo.corpus.appendingPathComponent("signed_unh_iol.pdf"))
        document = try await PdfDocument(data: bytes)
        let signatures = try await document.signatures()
        signature = try XCTUnwrap(signatures.first)
        anchor = try Data(contentsOf: Repo.root
            .appendingPathComponent("conformance/fixtures/unh-iol-signer.der"))
    }

    func testTheSignedRangesHashToTheMessageDigest() async throws {
        let cms = try CmsSignedData.parse([UInt8](signature.contents))
        let digest = try CmsVerifier.digestOverRanges(
            bytes: [UInt8](bytes), byteRange: signature.byteRange, kind: .sha256)
        XCTAssertEqual(digest, try XCTUnwrap(cms.messageDigest))
    }

    func testAValidSignatureFromAnUnknownIssuerIsUntrusted() async throws {
        let verdict = await document.verify(signature)
        guard case .untrusted(let chain, _) = verdict else {
            return XCTFail("expected untrusted, got \(verdict)")
        }
        XCTAssertFalse(chain.isEmpty, "the chain is reported even when it is not trusted")
        XCTAssertEqual(chain[0].commonName, "UNH-IOL")
    }

    func testTheSameSignatureIsValidOnceItsCertificateIsAnAnchor() async throws {
        let verdict = await document.verify(
            signature, options: PdfVerifyOptions(trustAnchors: [anchor]))
        guard case .valid(let signer, _) = verdict else {
            return XCTFail("expected valid, got \(verdict)")
        }
        XCTAssertEqual(signer.commonName, "UNH-IOL")
    }

    /// Tampering is an integrity failure and must not be reported as a trust problem.
    func testAChangedByteIsADigestMismatchNotUntrusted() async throws {
        var tampered = bytes
        tampered[100] ^= 0xff
        let doc = try await PdfDocument(data: tampered)
        let signatures = try await doc.signatures()
        let verdict = await doc.verify(try XCTUnwrap(signatures.first))
        XCTAssertEqual(verdict, .digestMismatch)
    }

    /// …and it stays a mismatch even when the signer is fully trusted.
    func testATrustedAnchorDoesNotRescueATamperedDocument() async throws {
        var tampered = bytes
        tampered[100] ^= 0xff
        let doc = try await PdfDocument(data: tampered)
        let signatures = try await doc.signatures()
        let verdict = await doc.verify(try XCTUnwrap(signatures.first),
                                       options: PdfVerifyOptions(trustAnchors: [anchor]))
        XCTAssertEqual(verdict, .digestMismatch)
    }

    /**
     The digest check runs first and catches a changed document, so this corrupts only
     the RSA signature value — leaving the messageDigest intact — to prove the signature
     itself is actually verified rather than assumed.

     `contents` is the whole /Contents placeholder, zero-padded by the signer, so the
     signature value is located inside the blob rather than indexed from its end.
     */
    func testACorruptedSignatureValueFailsEvenWhenTheDigestMatches() async throws {
        let cms = try CmsSignedData.parse([UInt8](signature.contents))
        var contents = [UInt8](signature.contents)
        let at = try XCTUnwrap(indexOf(cms.signature, in: contents),
                               "the signature value must be findable in the blob")
        contents[at + 8] ^= 0xff

        let forged = PdfSignature(
            index: signature.index, reason: signature.reason, signingTime: signature.signingTime,
            subFilter: signature.subFilter, byteRange: signature.byteRange,
            contents: Data(contents), docMdpPermission: signature.docMdpPermission,
            coversWholeDocument: signature.coversWholeDocument)

        let verdict = await document.verify(forged, options: PdfVerifyOptions(trustAnchors: [anchor]))
        XCTAssertEqual(verdict, .digestMismatch)
    }

    /// PDFium hands back the whole /Contents placeholder, which a signer pads with zeros
    /// to a fixed reserved size. Anything indexing from the end indexes into padding.
    func testContentsIsThePaddedPlaceholderNotJustTheDer() throws {
        let contents = [UInt8](signature.contents)
        let der = try Der.readTlv(contents, 0)
        XCTAssertLessThan(der.end, contents.count)
        XCTAssertTrue(contents[der.end...].allSatisfy { $0 == 0 })
    }

    func testAMalformedPkcs7IsReportedNotThrown() async throws {
        let broken = PdfSignature(
            index: 0, reason: nil, signingTime: nil, subFilter: signature.subFilter,
            byteRange: signature.byteRange, contents: Data([1, 2, 3]),
            docMdpPermission: nil, coversWholeDocument: true)
        guard case .malformed = await document.verify(broken) else {
            return XCTFail("expected malformed")
        }
    }

    private func indexOf(_ needle: [UInt8], in haystack: [UInt8]) -> Int? {
        guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
        for start in 0...(haystack.count - needle.count) {
            if Array(haystack[start..<(start + needle.count)]) == needle { return start }
        }
        return nil
    }
}
