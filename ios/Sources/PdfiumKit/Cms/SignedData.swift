import Foundation

/// Walking a PKCS#7 SignedData far enough to verify a PDF signature.
///
/// Only what verification needs: the certificates, the signer's identity, the
/// algorithms, the signed attributes and the signature value. Everything else in the
/// structure is stepped over rather than modelled.
struct CmsSignedData {
    /// DER-encoded certificates, in the order the file carries them.
    let certificates: [[UInt8]]
    /// Big-endian bytes of the signer's serial number.
    let signerSerial: [UInt8]
    let digestAlgorithm: String
    let signatureAlgorithm: String
    /// The signed attributes, re-tagged as a SET.
    ///
    /// This is what the signature is computed over. The file stores them
    /// `[0] IMPLICIT`, and verifying against those bytes fails for every signature
    /// ever made.
    let signedAttrs: [UInt8]?
    /// The `messageDigest` attribute: the digest the signer committed to.
    let messageDigest: [UInt8]?
    let signature: [UInt8]

    private enum Tag {
        static let sequence: UInt8 = 0x30
        static let set: UInt8 = 0x31
        static let octetString: UInt8 = 0x04
        static let oid: UInt8 = 0x06
        static let integer: UInt8 = 0x02
        static let context0: UInt8 = 0xa0
    }

    private enum Oid {
        static let signedData = "1.2.840.113549.1.7.2"
        static let messageDigest = "1.2.840.113549.1.9.4"
    }

    static func parse(_ pkcs7: [UInt8]) throws -> CmsSignedData {
        let contentInfo = try Der.readTlv(pkcs7, 0)
        guard contentInfo.tag == Tag.sequence else {
            throw Der.Failure(reason: "expected ContentInfo")
        }
        let parts = try Der.children(pkcs7, contentInfo)

        guard let contentType = parts.first, contentType.tag == Tag.oid,
              try Der.readOid(pkcs7, contentType) == Oid.signedData else {
            throw Der.Failure(reason: "not a signedData content type")
        }
        guard parts.count > 1, parts[1].tag == Tag.context0 else {
            throw Der.Failure(reason: "signedData has no content")
        }
        guard let signedData = try Der.children(pkcs7, parts[1]).first,
              signedData.tag == Tag.sequence else {
            throw Der.Failure(reason: "expected SignedData")
        }

        // version, digestAlgorithms, encapContentInfo, [certificates], [crls], signerInfos
        let fields = try Der.children(pkcs7, signedData)
        guard fields.count >= 4 else { throw Der.Failure(reason: "SignedData is too short") }

        let digestAlgorithm = try algorithmOid(pkcs7, fields[1], "digestAlgorithms")

        var certificates: [[UInt8]] = []
        for field in fields where field.tag == Tag.context0 {
            // [0] IMPLICIT CertificateSet. Its children are the certificates themselves.
            for certificate in try Der.children(pkcs7, field) where certificate.tag == Tag.sequence {
                certificates.append(Der.encoding(pkcs7, certificate))
            }
        }

        guard let signerInfos = fields.dropFirst(2).first(where: { $0.tag == Tag.set }),
              let signerInfo = try Der.children(pkcs7, signerInfos).first,
              signerInfo.tag == Tag.sequence else {
            throw Der.Failure(reason: "no signerInfos")
        }

        let signer = try parseSignerInfo(pkcs7, signerInfo)
        return CmsSignedData(
            certificates: certificates,
            signerSerial: signer.serial,
            digestAlgorithm: digestAlgorithm,
            signatureAlgorithm: signer.signatureAlgorithm,
            signedAttrs: signer.signedAttrs,
            messageDigest: signer.messageDigest,
            signature: signer.signature)
    }

    private struct SignerFields {
        let serial: [UInt8]
        let signatureAlgorithm: String
        let signedAttrs: [UInt8]?
        let messageDigest: [UInt8]?
        let signature: [UInt8]
    }

    private static func parseSignerInfo(_ pkcs7: [UInt8], _ signerInfo: Der.Tlv) throws -> SignerFields {
        // version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature
        let fields = try Der.children(pkcs7, signerInfo)
        guard fields.count >= 5 else { throw Der.Failure(reason: "SignerInfo is too short") }

        // sid is IssuerAndSerialNumber. The subjectKeyIdentifier form ([0]) is not used
        // by any PDF signer we have seen and would need the certificate to resolve, so
        // it is refused rather than half-handled.
        guard fields[1].tag == Tag.sequence else {
            throw Der.Failure(reason: "subjectKeyIdentifier signer id is not supported")
        }
        guard let serial = try Der.children(pkcs7, fields[1]).first(where: { $0.tag == Tag.integer }) else {
            throw Der.Failure(reason: "signer has no serial number")
        }

        let attrsField = fields.first { $0.tag == Tag.context0 }
        let signedAttrs = attrsField.map { retagAsSet(pkcs7, $0) }
        let messageDigest = try attrsField.flatMap { try findMessageDigest(pkcs7, $0) }

        let algorithmField: Der.Tlv
        if let attrsField, let index = fields.firstIndex(where: { $0.start == attrsField.start }),
           index + 1 < fields.count {
            algorithmField = fields[index + 1]
        } else {
            algorithmField = fields[fields.count - 2]
        }

        guard let signature = fields.last(where: { $0.tag == Tag.octetString }) else {
            throw Der.Failure(reason: "no signature value")
        }

        return SignerFields(
            serial: try Der.readIntegerBytes(pkcs7, serial),
            signatureAlgorithm: try algorithmOid(pkcs7, algorithmField, "signatureAlgorithm"),
            signedAttrs: signedAttrs,
            messageDigest: messageDigest,
            signature: Der.content(pkcs7, signature))
    }

    /// Re-encodes `[0] IMPLICIT SignedAttributes` as the `SET OF` the signature covers.
    ///
    /// Only the identifier octet changes; the length and contents are already correct,
    /// so the bytes are copied rather than re-encoded.
    private static func retagAsSet(_ pkcs7: [UInt8], _ attrs: Der.Tlv) -> [UInt8] {
        var out = Der.encoding(pkcs7, attrs)
        out[0] = Tag.set
        return out
    }

    private static func findMessageDigest(_ pkcs7: [UInt8], _ attrs: Der.Tlv) throws -> [UInt8]? {
        for attribute in try Der.children(pkcs7, attrs) where attribute.tag == Tag.sequence {
            let parts = try Der.children(pkcs7, attribute)
            guard parts.count >= 2, parts[0].tag == Tag.oid else { continue }
            guard try Der.readOid(pkcs7, parts[0]) == Oid.messageDigest else { continue }

            if let value = try Der.children(pkcs7, parts[1]).first, value.tag == Tag.octetString {
                return Der.content(pkcs7, value)
            }
        }
        return nil
    }

    /// AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL }
    private static func algorithmOid(_ pkcs7: [UInt8], _ field: Der.Tlv, _ what: String) throws -> String {
        // digestAlgorithms is a SET OF AlgorithmIdentifier; signatureAlgorithm is one.
        let identifier = field.tag == Tag.set
            ? try Der.children(pkcs7, field).first
            : field
        guard let identifier, identifier.tag == Tag.sequence else {
            throw Der.Failure(reason: "malformed \(what)")
        }
        guard let oid = try Der.children(pkcs7, identifier).first, oid.tag == Tag.oid else {
            throw Der.Failure(reason: "\(what) has no OID")
        }
        return try Der.readOid(pkcs7, oid)
    }
}
