import Foundation
@_implementationOnly import CPdfium

/// A signature already present in a document. Reading only; nothing here is verified.
public struct PdfSignature: Sendable, Equatable {
    public let index: Int
    public let reason: String?
    /// The time the signer claimed. Not trusted, and not a timestamp authority's.
    public let signingTime: Date?
    /// e.g. `adbe.pkcs7.detached`, `ETSI.CAdES.detached`.
    public let subFilter: String?
    /// Pairs of offset and length covering the signed spans of the file.
    public let byteRange: [Int]
    /// The raw PKCS#7 blob, for a verifier to check.
    public let contents: Data
    public let docMdpPermission: Int?

    /// Whether the signed ranges reach the end of the file.
    ///
    /// A signature can be cryptographically valid and still cover only part of the
    /// document; anything appended afterwards is unprotected.
    public let coversWholeDocument: Bool
}

extension PdfDocument {
    /// Signatures already present in the document. Reading only; nothing is verified.
    ///
    /// PDFium exposes no way to create a signature and no crypto at all, so `contents`
    /// is handed back as the raw PKCS#7 blob for a verifier to check.
    public func signatures() throws -> [PdfSignature] {
        let document = try requireHandle()
        let total: Int32 = FPDF_GetSignatureCount(document)
        guard total > 0 else { return [] }

        let fileLength = backing.count
        var result: [PdfSignature] = []
        for index in 0..<total {
            guard let handle = FPDF_GetSignatureObject(document, index) else { continue }
            let byteRange = Self.readByteRange(handle)
            result.append(PdfSignature(
                index: Int(index),
                reason: Self.readReason(handle).nilIfEmpty,
                signingTime: Self.parsePdfDate(Self.readAscii(handle, FPDFSignatureObj_GetTime)),
                subFilter: Self.readAscii(handle, FPDFSignatureObj_GetSubFilter).nilIfEmpty,
                byteRange: byteRange,
                contents: Self.readContents(handle),
                docMdpPermission: Self.readDocMdp(handle),
                coversWholeDocument: Self.coversWholeDocument(byteRange, fileLength: fileLength)))
        }
        return result
    }

    /// Computed, not read. Treating "has a valid signature" as "is unmodified" is how a
    /// signed document gets silently amended.
    private static func coversWholeDocument(_ byteRange: [Int], fileLength: Int) -> Bool {
        guard byteRange.count >= 2 else { return false }
        return byteRange[byteRange.count - 2] + byteRange[byteRange.count - 1] == fileLength
    }

    private static func readByteRange(_ signature: FPDF_SIGNATURE) -> [Int] {
        let count = FPDFSignatureObj_GetByteRange(signature, nil, 0)
        guard count > 0 else { return [] }

        var values = [Int32](repeating: 0, count: Int(count))
        _ = values.withUnsafeMutableBufferPointer {
            FPDFSignatureObj_GetByteRange(signature, $0.baseAddress, UInt(count))
        }
        return values.map(Int.init)
    }

    private static func readContents(_ signature: FPDF_SIGNATURE) -> Data {
        let size = FPDFSignatureObj_GetContents(signature, nil, 0)
        guard size > 0 else { return Data() }

        var bytes = [UInt8](repeating: 0, count: Int(size))
        _ = bytes.withUnsafeMutableBufferPointer {
            FPDFSignatureObj_GetContents(signature, $0.baseAddress, UInt(size))
        }
        return Data(bytes)
    }

    /// `/Reason` is UTF-16LE, unlike the sub-filter and time, which the header
    /// documents as 7-bit ASCII.
    private static func readReason(_ signature: FPDF_SIGNATURE) -> String {
        let size = FPDFSignatureObj_GetReason(signature, nil, 0)
        guard size > 2 else { return "" }          // a lone terminator means absent

        var units = [UInt16](repeating: 0, count: Int(size) / 2)
        _ = units.withUnsafeMutableBufferPointer {
            FPDFSignatureObj_GetReason(signature, $0.baseAddress, size)
        }
        if units.last == 0 { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    /// The sub-filter and time are 7-bit ASCII byte strings, not PDFium's usual UTF-16.
    private static func readAscii(
        _ signature: FPDF_SIGNATURE,
        _ fn: (FPDF_SIGNATURE?, UnsafeMutablePointer<CChar>?, UInt) -> UInt
    ) -> String {
        let size = fn(signature, nil, 0)
        guard size > 0 else { return "" }

        var bytes = [CChar](repeating: 0, count: Int(size))
        _ = bytes.withUnsafeMutableBufferPointer { fn(signature, $0.baseAddress, size) }
        // PDFium counts the trailing NUL in the reported size for these fields.
        if bytes.last == 0 { bytes.removeLast() }
        return String(decoding: bytes.map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    private static func readDocMdp(_ signature: FPDF_SIGNATURE) -> Int? {
        let value = FPDFSignatureObj_GetDocMDPPermission(signature)
        return value > 0 ? Int(value) : nil
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
