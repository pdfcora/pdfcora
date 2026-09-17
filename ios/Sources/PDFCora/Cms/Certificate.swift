import Foundation
import Security

/// A certificate from a signature's chain.
public struct PdfCertificateInfo: Sendable, Equatable {
    public let commonName: String?
    public let serialNumber: Data
    public let notBefore: Date
    public let notAfter: Date
    /// The certificate as DER, for callers that want to inspect it further.
    public let der: Data

    /// Raw DER of the subject and issuer Names.
    ///
    /// Kept as bytes so chain building can compare them exactly. Re-encoding a Name to
    /// compare it as text is where subtle mismatches come from.
    let subject: [UInt8]
    let issuer: [UInt8]
}

enum CertificateReader {
    private enum Tag {
        static let sequence: UInt8 = 0x30
        static let set: UInt8 = 0x31
        static let oid: UInt8 = 0x06
        static let context0: UInt8 = 0xa0
        static let utcTime: UInt8 = 0x17
    }

    private static let commonNameOid = "2.5.4.3"

    static func parse(_ der: [UInt8]) throws -> PdfCertificateInfo {
        let certificate = try Der.readTlv(der, 0)
        guard certificate.tag == Tag.sequence else {
            throw Der.Failure(reason: "certificate is not a SEQUENCE")
        }
        guard let tbs = try Der.children(der, certificate).first, tbs.tag == Tag.sequence else {
            throw Der.Failure(reason: "certificate has no tbsCertificate")
        }

        let fields = try Der.children(der, tbs)
        // version is [0] EXPLICIT and optional; everything after it shifts by one.
        let base = fields.first?.tag == Tag.context0 ? 1 : 0
        guard fields.count > base + 5 else {
            throw Der.Failure(reason: "tbsCertificate is missing required fields")
        }

        let validity = try Der.children(der, fields[base + 3])
        guard validity.count >= 2 else {
            throw Der.Failure(reason: "certificate has no validity period")
        }

        return PdfCertificateInfo(
            commonName: try findCommonName(der, fields[base + 4]),
            serialNumber: Data(try Der.readIntegerBytes(der, fields[base])),
            notBefore: try parseTime(der, validity[0]),
            notAfter: try parseTime(der, validity[1]),
            der: Data(der),
            subject: Der.encoding(der, fields[base + 4]),
            issuer: Der.encoding(der, fields[base + 2]))
    }

    /// Name ::= SEQUENCE OF RelativeDistinguishedName (SET OF AttributeTypeAndValue).
    private static func findCommonName(_ der: [UInt8], _ name: Der.Tlv) throws -> String? {
        for rdn in try Der.children(der, name) where rdn.tag == Tag.set {
            for attribute in try Der.children(der, rdn) {
                let parts = try Der.children(der, attribute)
                guard parts.count >= 2, parts[0].tag == Tag.oid else { continue }
                guard try Der.readOid(der, parts[0]) == commonNameOid else { continue }
                return String(decoding: Der.content(der, parts[1]), as: UTF8.self)
            }
        }
        return nil
    }

    /// UTCTime is `YYMMDDHHMMSSZ`, windowed at 2049 per RFC 5280; GeneralizedTime is
    /// `YYYYMMDDHHMMSSZ`. Only the Z forms appear in certificates.
    private static func parseTime(_ der: [UInt8], _ tlv: Der.Tlv) throws -> Date {
        let text = String(decoding: Der.content(der, tlv), as: UTF8.self)
        let isUtcTime = tlv.tag == Tag.utcTime
        let digits = text.prefix { $0.isNumber }
        guard digits.count >= (isUtcTime ? 10 : 12) else {
            throw Der.Failure(reason: "unparseable certificate time \(text)")
        }

        func part(_ start: Int, _ length: Int) -> Int {
            let from = digits.index(digits.startIndex, offsetBy: start)
            let to = digits.index(from, offsetBy: length)
            return Int(digits[from..<to]) ?? 0
        }

        var components = DateComponents()
        if isUtcTime {
            let year = part(0, 2)
            components.year = year >= 50 ? 1900 + year : 2000 + year
            components.month = part(2, 2); components.day = part(4, 2)
            components.hour = part(6, 2); components.minute = part(8, 2)
            components.second = digits.count >= 12 ? part(10, 2) : 0
        } else {
            components.year = part(0, 4)
            components.month = part(4, 2); components.day = part(6, 2)
            components.hour = part(8, 2); components.minute = part(10, 2)
            components.second = digits.count >= 14 ? part(12, 2) : 0
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let date = calendar.date(from: components) else {
            throw Der.Failure(reason: "unparseable certificate time \(text)")
        }
        return date
    }

    /// A certificate that issued itself, which a chain cannot climb past.
    static func isSelfIssued(_ certificate: PdfCertificateInfo) -> Bool {
        certificate.subject == certificate.issuer
    }

    /// Orders certificates from the signer upward, following issuer links.
    ///
    /// Stops at a self-issued certificate or when no issuer is present, so a cycle in a
    /// malformed bundle cannot loop forever.
    static func buildChain(
        from signer: PdfCertificateInfo,
        pool: [PdfCertificateInfo]
    ) -> [PdfCertificateInfo] {
        var chain = [signer]
        var seen: Set<Data> = [signer.der]
        var current = signer

        while !isSelfIssued(current) {
            guard let issuer = pool.first(where: { $0.subject == current.issuer }),
                  !seen.contains(issuer.der) else { break }
            chain.append(issuer)
            seen.insert(issuer.der)
            current = issuer
        }
        return chain
    }

    /// The public key, via Security.framework rather than by re-parsing the
    /// SubjectPublicKeyInfo ourselves. The platform already does this correctly.
    static func publicKey(of certificate: PdfCertificateInfo) -> SecKey? {
        guard let secCertificate = SecCertificateCreateWithData(nil, certificate.der as CFData) else {
            return nil
        }
        return SecCertificateCopyKey(secCertificate)
    }
}
