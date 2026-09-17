import CryptoKit
import Foundation
import Security

/// Produces a detached CMS SignedData over `data`.
///
/// Given the data rather than a digest: every CMS API wants the content, computes the
/// digest itself and puts it in the signed attributes. Passing only a digest would force
/// each implementation to hand-build them.
public protocol CmsSigner: Sendable {
    func sign(_ data: Data) async throws -> Data
}

public struct PdfSignOptions: Sendable {
    public var signer: CmsSigner
    public var reason: String?
    public var contactInfo: String?
    public var fieldName: String?
    public var pageIndex: Int
    /// Bytes reserved for the signature. 8192 fits RSA-2048 with a timestamp.
    public var reservedBytes: Int
    /// `ETSI.CAdES.detached` is PAdES and requires the signer to produce CAdES-BES.
    /// Strict verifiers reject a plain PKCS#7 under it even when the signature is sound.
    public var subFilter: String
    /// An RFC 3161 authority, raising the signature from PAdES B-B to B-T. Absent by
    /// default: it needs a network call, and a signature without one is still valid.
    public var timestampUrl: URL?

    public init(
        signer: CmsSigner,
        reason: String? = nil,
        contactInfo: String? = nil,
        fieldName: String? = nil,
        pageIndex: Int = 0,
        reservedBytes: Int = 8192,
        subFilter: String = "ETSI.CAdES.detached",
        timestampUrl: URL? = nil
    ) {
        self.signer = signer
        self.reason = reason
        self.contactInfo = contactInfo
        self.fieldName = fieldName
        self.pageIndex = pageIndex
        self.reservedBytes = reservedBytes
        self.subFilter = subFilter
        self.timestampUrl = timestampUrl
    }
}

extension PdfDocument {
    /// Signs the document, returning the signed bytes.
    ///
    /// The original bytes are never modified: the signature is appended as an incremental
    /// update, so any signature already present keeps verifying. Without a signing
    /// license the bytes are first watermarked, which is a full rewrite, so earlier
    /// signatures in the result no longer verify.
    public func sign(_ options: PdfSignOptions) async throws -> Data {
        use(.signing)
        guard needsWatermark else { return try await Signer.sign(backing, options: options) }
        noteWatermarked()
        _ = try requireHandle()
        return try await Signer.sign(try Watermark.stamp(backing), options: options)
    }
}

enum Signer {
    static func sign(_ base: Data, options: PdfSignOptions) async throws -> Data {
        let placed = try SignatureField.place(in: base, options: SignatureField.Options(
            reservedBytes: options.reservedBytes,
            reason: options.reason,
            contactInfo: options.contactInfo,
            fieldName: options.fieldName,
            pageIndex: options.pageIndex,
            subFilter: options.subFilter))

        // The signed content is the file with the placeholder cut out — exactly what the
        // byte range names, and exactly what a verifier will re-assemble.
        let content = concatRanges(placed.bytes, placed.byteRange)
        var cms = [UInt8](try await options.signer.sign(Data(content)))
        guard !cms.isEmpty else {
            throw PdfError.saveFailed(reason: "sign: the signer returned nothing")
        }

        if let url = options.timestampUrl {
            // Any failure here throws, so a document is never returned with a timestamp
            // that was requested and silently not applied.
            let signatureValue = try CmsSignedData.parse(cms).signature
            cms = try await Timestamp.apply(to: cms, signatureValue: signatureValue, url: url)
        }

        guard cms.count <= options.reservedBytes else {
            // Truncating would produce a file that opens and fails to verify, with no
            // clue why.
            throw PdfError.saveFailed(reason:
                "sign: the signature is \(cms.count) bytes but only \(options.reservedBytes) "
                + "were reserved; pass a larger reservedBytes")
        }

        return Data(patchContents(placed.bytes, placed.contentsAt, cms))
    }

    /// Writes the signature into the placeholder as hex, leaving the rest as zeros.
    private static func patchContents(_ bytes: [UInt8], _ contentsAt: Int, _ cms: [UInt8]) -> [UInt8] {
        var out = bytes
        // contentsAt points at '<'; the hex begins one byte later and the space is
        // already '0', so only the signature's own digits are written.
        var cursor = contentsAt + 1
        for byte in cms {
            out[cursor] = hexDigits[Int(byte >> 4)]; cursor += 1
            out[cursor] = hexDigits[Int(byte & 0x0f)]; cursor += 1
        }
        return out
    }

    private static let hexDigits = Array("0123456789ABCDEF".utf8)

    private static func concatRanges(_ bytes: [UInt8], _ byteRange: [Int]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(stride(from: 1, to: byteRange.count, by: 2).reduce(0) { $0 + byteRange[$1] })
        for pair in stride(from: 0, to: byteRange.count, by: 2) {
            let start = byteRange[pair], length = byteRange[pair + 1]
            out += bytes[start..<min(bytes.count, start + length)]
        }
        return out
    }
}

/// Signs with a PKCS#12 identity, using Security.framework.
///
/// Unlike web, iOS needs no app-supplied CMS: the platform can build one. The CAdES
/// `signingCertificateV2` attribute is added so the default `ETSI.CAdES.detached`
/// sub-filter is honest about what the CMS contains.
public struct Pkcs12Signer: CmsSigner {
    private let identity: SecIdentity
    private let certificate: SecCertificate

    public init(pkcs12: Data, password: String) throws {
        var items: CFArray?
        let status = SecPKCS12Import(
            pkcs12 as CFData, [kSecImportExportPassphrase as String: password] as CFDictionary, &items)
        guard status == errSecSuccess,
              let first = (items as? [[String: Any]])?.first,
              let identity = first[kSecImportItemIdentity as String] else {
            throw PdfError.saveFailed(reason: "sign: the PKCS#12 could not be opened (\(status))")
        }
        self.identity = identity as! SecIdentity

        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(self.identity, &certificate) == errSecSuccess,
              let certificate else {
            throw PdfError.saveFailed(reason: "sign: the identity has no certificate")
        }
        self.certificate = certificate
    }

    public func sign(_ data: Data) async throws -> Data {
        var key: SecKey?
        guard SecIdentityCopyPrivateKey(identity, &key) == errSecSuccess, let key else {
            throw PdfError.saveFailed(reason: "sign: the identity has no private key")
        }
        return Data(try CmsBuilder.signedData(
            content: [UInt8](data),
            certificate: [UInt8](SecCertificateCopyData(certificate) as Data),
            sign: { bytes in
                var error: Unmanaged<CFError>?
                guard let signature = SecKeyCreateSignature(
                    key, .rsaSignatureMessagePKCS1v15SHA256, Data(bytes) as CFData, &error) else {
                    throw PdfError.saveFailed(reason:
                        "sign: \(error?.takeRetainedValue().localizedDescription ?? "signing failed")")
                }
                return [UInt8](signature as Data)
            }))
    }
}
