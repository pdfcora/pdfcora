import CryptoKit
import Foundation

/// RFC 3161 timestamping, which raises a signature from PAdES B-B to B-T.
///
/// A timestamp is a second signature, made by an authority over the first one's signature
/// value. It proves the signing happened before a given instant, so the signature stays
/// verifiable after the signer's certificate expires.
///
/// The token is embedded as an *unsigned* attribute: it is created after the signature
/// exists and therefore cannot be inside what the signature covers.
enum Timestamp {
    private static let sha256Oid = "2.16.840.1.101.3.4.2.1"
    /// id-aa-timeStampToken
    private static let tokenOid = "1.2.840.113549.1.9.16.2.14"

    struct Failure: Error, CustomStringConvertible {
        let reason: String
        var description: String { "timestamp: \(reason)" }
    }

    /// A `TimeStampReq` over `data`'s digest.
    ///
    /// `certReq` is set so the authority returns its certificate; without it a verifier
    /// has nothing to check the token against.
    static func request(over data: [UInt8]) -> [UInt8] {
        let digest = [UInt8](SHA256.hash(data: data))
        var nonce = [UInt8](repeating: 0, count: 8)
        for i in nonce.indices { nonce[i] = UInt8.random(in: 0...255) }
        // A nonce ties the response to this request, so a replay is detectable.
        nonce[0] &= 0x7f

        return DerEncode.sequence(
            DerEncode.integer(1),
            DerEncode.sequence(
                DerEncode.sequence(DerEncode.oid(sha256Oid)),
                DerEncode.octetString(digest)),
            DerEncode.integer(nonce),
            DerEncode.boolean(true))
    }

    /// Extracts the token from a `TimeStampResp`, or explains why there is none.
    ///
    /// PKIStatus 0 is granted and 1 is granted with modifications; anything else is a
    /// refusal and must not produce a half-signed document.
    static func token(from response: [UInt8]) throws -> [UInt8] {
        let outer: Der.Tlv
        do { outer = try Der.readTlv(response, 0) }
        catch { throw Failure(reason: "unreadable response: \(error)") }
        guard outer.tag == DerEncode.Tag.sequence else {
            throw Failure(reason: "response is not a SEQUENCE")
        }

        let parts = try Der.children(response, outer)
        guard let statusInfo = parts.first,
              let statusValue = try Der.children(response, statusInfo).first,
              statusValue.tag == DerEncode.Tag.integer else {
            throw Failure(reason: "response has no status")
        }
        let status = Der.content(response, statusValue).reduce(0) { $0 * 256 + Int($1) }
        guard status == 0 || status == 1 else {
            throw Failure(reason: "the authority refused the request, PKIStatus \(status)")
        }

        guard parts.count > 1 else { throw Failure(reason: "the response carries no token") }
        return Array(response[parts[1].start..<parts[1].end])
    }

    /// Puts a token into a CMS SignedData's first SignerInfo.
    ///
    /// The wrappers around the SignerInfo are re-encoded rather than patched: their
    /// lengths change, and a length crossing the 127-byte boundary changes width too, so
    /// editing bytes in place would corrupt the structure.
    static func embed(_ token: [UInt8], into cms: [UInt8]) throws -> [UInt8] {
        let contentInfo = try Der.readTlv(cms, 0)
        let top = try Der.children(cms, contentInfo)
        guard top.count >= 2 else { throw Failure(reason: "not a CMS ContentInfo") }
        guard let signedData = try Der.children(cms, top[1]).first else {
            throw Failure(reason: "ContentInfo has no SignedData")
        }

        let fields = try Der.children(cms, signedData)
        guard let signerInfosIndex = fields.indices.first(where: {
            $0 > 1 && fields[$0].tag == DerEncode.Tag.set
        }) else { throw Failure(reason: "SignedData has no signerInfos") }

        let signerInfos = try Der.children(cms, fields[signerInfosIndex])
        guard let first = signerInfos.first, first.tag == DerEncode.Tag.sequence else {
            throw Failure(reason: "malformed SignerInfo")
        }
        if try Der.children(cms, first).contains(where: { $0.tag == DerEncode.Tag.context1 }) {
            throw Failure(reason: "the SignerInfo already carries unsigned attributes")
        }

        let attribute = DerEncode.sequence(DerEncode.oid(tokenOid), DerEncode.set(token))
        let unsignedAttrs = DerEncode.tlv(DerEncode.Tag.context1, attribute)

        let newSignerInfo = DerEncode.sequence(Der.content(cms, first) + unsignedAttrs)
        let newSignerInfos = DerEncode.set(
            signerInfos.dropFirst().flatMap { Array(cms[$0.start..<$0.end]) } + newSignerInfo)

        var body: [UInt8] = []
        for (index, field) in fields.enumerated() {
            body += index == signerInfosIndex ? newSignerInfos : Array(cms[field.start..<field.end])
        }

        return DerEncode.sequence(
            Array(cms[top[0].start..<top[0].end]),
            DerEncode.tlv(DerEncode.Tag.context0, DerEncode.sequence(body)))
    }

    /// Requests a token from `url` and embeds it.
    static func apply(to cms: [UInt8], signatureValue: [UInt8], url: URL) async throws -> [UInt8] {
        var httpRequest = URLRequest(url: url)
        httpRequest.httpMethod = "POST"
        httpRequest.setValue("application/timestamp-query", forHTTPHeaderField: "Content-Type")
        httpRequest.httpBody = Data(request(over: signatureValue))

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: httpRequest)
        } catch {
            // A document with no timestamp is better than one with a broken signature,
            // so the caller is told rather than handed a half-signed file.
            throw Failure(reason: "could not reach the authority: \(error.localizedDescription)")
        }

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw Failure(reason: "the authority returned HTTP \(http.statusCode)")
        }
        return try embed(try token(from: [UInt8](data)), into: cms)
    }
}
