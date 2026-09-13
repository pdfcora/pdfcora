import CryptoKit
import Foundation
import Security

/// The outcome of verifying a signature.
///
/// Integrity and trust are deliberately separate outcomes. ``valid`` means the bytes
/// have not changed **and** the chain reaches a supplied anchor; a signature that is
/// cryptographically intact but whose issuer is unknown is ``untrusted``, not valid.
///
/// Revocation (CRL/OCSP) is not checked, so ``valid`` does not mean the certificate is
/// still in good standing.
public enum PdfSignatureValidity: Sendable, Equatable {
    case valid(signer: PdfCertificateInfo, timestamp: Date? = nil)
    /// The signed bytes changed after signing.
    case digestMismatch
    /// Cryptographically intact, but the chain does not reach a trusted anchor.
    case untrusted(chain: [PdfCertificateInfo], reason: String)
    case expired(at: Date)
    case malformed(reason: String)
    case unsupported(subFilter: String)
}

public struct PdfVerifyOptions: Sendable {
    /// DER-encoded certificates to trust. With none supplied, nothing is trusted.
    public var trustAnchors: [Data]
    /// The instant to judge validity at. Defaults to now; set it to make tests stable.
    public var at: Date?

    public init(trustAnchors: [Data] = [], at: Date? = nil) {
        self.trustAnchors = trustAnchors
        self.at = at
    }
}

extension PdfDocument {
    /// Verifies a signature this document carries.
    ///
    /// Reports integrity and trust separately: a signature whose bytes are intact but
    /// whose issuer is unknown comes back ``PdfSignatureValidity/untrusted(chain:reason:)``,
    /// never valid. Revocation is not checked.
    public func verify(
        _ signature: PdfSignature,
        options: PdfVerifyOptions = PdfVerifyOptions()
    ) -> PdfSignatureValidity {
        CmsVerifier.verify(bytes: [UInt8](backing), signature: signature, options: options)
    }
}

enum CmsVerifier {
    /// Digest algorithms by OID, as they appear in a CMS `digestAlgorithm`.
    private static let digestByOid: [String: DigestKind] = [
        "2.16.840.1.101.3.4.2.1": .sha256,
        "2.16.840.1.101.3.4.2.2": .sha384,
        "2.16.840.1.101.3.4.2.3": .sha512,
        // SHA-1 is listed so a document signed with it is reported as such rather than
        // as malformed. Whether to accept it is a policy decision made further up.
        "1.3.14.3.2.26": .sha1,
    ]

    /// Signature algorithms by OID. rsaEncryption appears when the digest is carried
    /// separately in digestAlgorithm, which is common in PDF signers.
    private static let rsaOids: Set<String> = [
        "1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13",
        "1.2.840.113549.1.1.5", "1.2.840.113549.1.1.1",
    ]
    private static let ecdsaOids: Set<String> = [
        "1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4",
    ]

    private static let supportedSubFilters: Set<String> = [
        "adbe.pkcs7.detached", "ETSI.CAdES.detached", "adbe.pkcs7.sha1",
    ]

    enum DigestKind { case sha1, sha256, sha384, sha512 }

    static func verify(
        bytes: [UInt8],
        signature: PdfSignature,
        options: PdfVerifyOptions
    ) -> PdfSignatureValidity {
        let cms: CmsSignedData
        do {
            cms = try CmsSignedData.parse([UInt8](signature.contents))
        } catch {
            return .malformed(reason: "\(error)")
        }

        if let subFilter = signature.subFilter, !supportedSubFilters.contains(subFilter) {
            return .unsupported(subFilter: subFilter)
        }

        let certificates: [PdfCertificateInfo]
        do {
            certificates = try cms.certificates.map { try CertificateReader.parse($0) }
        } catch {
            return .malformed(reason: "\(error)")
        }
        guard let signer = certificates.first(where: { [UInt8]($0.serialNumber) == cms.signerSerial })
                ?? certificates.first else {
            return .malformed(reason: "no signer certificate")
        }

        // Integrity first, so tampering is never reported as a trust problem.
        do {
            guard try checkDigest(bytes: bytes, signature: signature, cms: cms) else {
                return .digestMismatch
            }
            guard try checkSignature(cms: cms, signer: signer) else { return .digestMismatch }
        } catch {
            return .malformed(reason: "\(error)")
        }

        let now = options.at ?? Date()
        if now < signer.notBefore || now > signer.notAfter {
            return .expired(at: signer.notAfter)
        }

        let chain = CertificateReader.buildChain(from: signer, pool: certificates)
        let anchors = options.trustAnchors.compactMap { try? CertificateReader.parse([UInt8]($0)) }
        let trusted = chain.contains { link in anchors.contains { $0.der == link.der } }

        guard trusted else {
            let root = chain[chain.count - 1]
            let reason: String
            if anchors.isEmpty {
                reason = "no trust anchors were supplied"
            } else if CertificateReader.isSelfIssued(root) {
                reason = "the chain ends at a self-issued certificate that is not an anchor"
            } else {
                reason = "the issuer is unknown"
            }
            return .untrusted(chain: chain, reason: reason)
        }

        return .valid(signer: signer)
    }

    /// Hashes the spans a `/ByteRange` names, in the order it names them.
    ///
    /// The gap between the ranges is the `/Contents` placeholder holding the signature
    /// itself — genuinely outside the signed data.
    static func digestOverRanges(
        bytes: [UInt8], byteRange: [Int], kind: DigestKind
    ) throws -> [UInt8] {
        guard byteRange.count >= 2, byteRange.count % 2 == 0 else {
            throw Der.Failure(reason: "byte range must be offset/length pairs")
        }

        var signed: [UInt8] = []
        for pair in stride(from: 0, to: byteRange.count, by: 2) {
            let start = byteRange[pair]
            let length = byteRange[pair + 1]
            guard start >= 0, length >= 0, start + length <= bytes.count else {
                throw Der.Failure(reason: "byte range \(start)+\(length) runs past the file")
            }
            signed.append(contentsOf: bytes[start..<(start + length)])
        }

        switch kind {
        case .sha1: return Array(Insecure.SHA1.hash(data: signed))
        case .sha256: return Array(SHA256.hash(data: signed))
        case .sha384: return Array(SHA384.hash(data: signed))
        case .sha512: return Array(SHA512.hash(data: signed))
        }
    }

    static func checkDigest(
        bytes: [UInt8], signature: PdfSignature, cms: CmsSignedData
    ) throws -> Bool {
        guard let expected = cms.messageDigest else { return false }
        guard let kind = digestByOid[cms.digestAlgorithm] else {
            throw Der.Failure(reason: "unsupported digest algorithm \(cms.digestAlgorithm)")
        }
        let actual = try digestOverRanges(bytes: bytes, byteRange: signature.byteRange, kind: kind)
        return constantTimeEqual(actual, expected)
    }

    /// Verifies the signature over the signed attributes.
    ///
    /// The signature covers the SET encoding, which ``CmsSignedData`` already re-tagged.
    /// A detached PDF signature always has signed attributes, so their absence is
    /// refused rather than guessed at.
    private static func checkSignature(cms: CmsSignedData, signer: PdfCertificateInfo) throws -> Bool {
        guard let signedAttrs = cms.signedAttrs else {
            throw Der.Failure(reason: "signature has no signed attributes")
        }
        guard let key = CertificateReader.publicKey(of: signer) else {
            throw Der.Failure(reason: "could not read the signer's public key")
        }

        let kind = digestByOid[cms.digestAlgorithm] ?? .sha256
        let algorithm: SecKeyAlgorithm
        if rsaOids.contains(cms.signatureAlgorithm) {
            switch kind {
            case .sha1: algorithm = .rsaSignatureMessagePKCS1v15SHA1
            case .sha256: algorithm = .rsaSignatureMessagePKCS1v15SHA256
            case .sha384: algorithm = .rsaSignatureMessagePKCS1v15SHA384
            case .sha512: algorithm = .rsaSignatureMessagePKCS1v15SHA512
            }
        } else if ecdsaOids.contains(cms.signatureAlgorithm) {
            switch kind {
            case .sha384: algorithm = .ecdsaSignatureMessageX962SHA384
            case .sha512: algorithm = .ecdsaSignatureMessageX962SHA512
            default: algorithm = .ecdsaSignatureMessageX962SHA256
            }
        } else {
            throw Der.Failure(reason: "unsupported signature algorithm \(cms.signatureAlgorithm)")
        }

        return SecKeyVerifySignature(
            key, algorithm,
            Data(signedAttrs) as CFData,
            Data(cms.signature) as CFData,
            nil)
    }

    /// Compares in constant time with respect to content. Not the classic timing-attack
    /// target, but an early return costs nothing to avoid in code like this.
    static func constantTimeEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for i in 0..<a.count { difference |= a[i] ^ b[i] }
        return difference == 0
    }
}
