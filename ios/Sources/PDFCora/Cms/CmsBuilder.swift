import CryptoKit
import Foundation

/// Building a detached CMS SignedData.
///
/// Unlike web, iOS can do this natively — the platform signs, and only the container is
/// ours. The signature covers the signed attributes, which carry the digest of the
/// content rather than the content itself; that is what makes the CMS detached.
enum CmsBuilder {
    private enum Oid {
        static let signedData = "1.2.840.113549.1.7.2"
        static let data = "1.2.840.113549.1.7.1"
        static let sha256 = "2.16.840.1.101.3.4.2.1"
        static let rsaEncryption = "1.2.840.113549.1.1.1"
        static let contentType = "1.2.840.113549.1.9.3"
        static let messageDigest = "1.2.840.113549.1.9.4"
        /// id-aa-signingCertificateV2, which CAdES-BES requires.
        static let signingCertificateV2 = "1.2.840.113549.1.9.16.2.47"
    }

    /// `sign` receives the DER-encoded signed attributes and returns a signature over them.
    static func signedData(
        content: [UInt8],
        certificate: [UInt8],
        sign: ([UInt8]) throws -> [UInt8]
    ) throws -> [UInt8] {
        let parsed = try CertificateReader.parse(certificate)
        let contentDigest = [UInt8](SHA256.hash(data: content))
        let certificateDigest = [UInt8](SHA256.hash(data: certificate))

        let attributes = [
            attribute(Oid.contentType, DerEncode.oid(Oid.data)),
            attribute(Oid.messageDigest, DerEncode.octetString(contentDigest)),
            // ESSCertIDv2 with the default SHA-256 hash algorithm omitted, as the
            // definition allows.
            attribute(Oid.signingCertificateV2, DerEncode.sequence(
                DerEncode.sequence(
                    DerEncode.sequence(DerEncode.octetString(certificateDigest))))),
        ]

        // The signature covers the SET encoding, which is why the attributes are built
        // once here and reused rather than re-encoded.
        let signedAttrs = DerEncode.set(attributes.flatMap { $0 })
        let signature = try sign(signedAttrs)

        let signerInfo = DerEncode.sequence(
            DerEncode.integer(1),
            DerEncode.sequence(parsed.issuer, DerEncode.integer([UInt8](parsed.serialNumber))),
            DerEncode.sequence(DerEncode.oid(Oid.sha256)),
            // [0] IMPLICIT in the file, though the signature covered the SET form.
            DerEncode.tlv(DerEncode.Tag.context0, Array(signedAttrs.dropFirst(headerLength(signedAttrs)))),
            DerEncode.sequence(DerEncode.oid(Oid.rsaEncryption)),
            DerEncode.octetString(signature))

        let body = DerEncode.sequence(
            DerEncode.integer(1),
            DerEncode.set(DerEncode.sequence(DerEncode.oid(Oid.sha256))),
            DerEncode.sequence(DerEncode.oid(Oid.data)),      // detached: no eContent
            DerEncode.tlv(DerEncode.Tag.context0, certificate),
            DerEncode.set(signerInfo))

        return DerEncode.sequence(
            DerEncode.oid(Oid.signedData),
            DerEncode.tlv(DerEncode.Tag.context0, body))
    }

    private static func attribute(_ oid: String, _ value: [UInt8]) -> [UInt8] {
        DerEncode.sequence(DerEncode.oid(oid), DerEncode.set(value))
    }

    /// How many bytes the tag and length occupy, so the SET's content can be re-tagged.
    private static func headerLength(_ encoded: [UInt8]) -> Int {
        guard encoded.count > 1 else { return encoded.count }
        let first = encoded[1]
        return first < 0x80 ? 2 : 2 + Int(first & 0x7f)
    }
}
