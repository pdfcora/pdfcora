import Foundation
@_implementationOnly import CPdfium

/// Typed document metadata. Non-standard keys are reachable via ``subscript(custom:)``.
public struct PdfMetadata: Equatable, Sendable {
    public var title: String?
    public var author: String?
    public var subject: String?
    public var keywords: String?
    public var creator: String?
    public var producer: String?
    public var creationDate: Date?
    public var modificationDate: Date?
}

extension PdfDocument {
    public var metadata: PdfMetadata {
        get throws {
            _ = try requireHandle()
            return PdfMetadata(
                title: metaText("Title"),
                author: metaText("Author"),
                subject: metaText("Subject"),
                keywords: metaText("Keywords"),
                creator: metaText("Creator"),
                producer: metaText("Producer"),
                creationDate: metaText("CreationDate").flatMap(Self.parsePdfDate),
                modificationDate: metaText("ModDate").flatMap(Self.parsePdfDate)
            )
        }
    }

    /// Reads a metadata key that ``metadata`` does not model.
    public subscript(custom key: String) -> String? {
        get throws {
            _ = try requireHandle()
            return metaText(key)
        }
    }

    private func metaText(_ key: String) -> String? {
        guard let handle else { return nil }
        let byteCount = FPDF_GetMetaText(handle, key, nil, 0)
        // PDFium returns the terminator alone (2 bytes) when the key is absent.
        guard byteCount > 2 else { return nil }
        var buffer = [UInt16](repeating: 0, count: Int(byteCount) / 2)
        FPDF_GetMetaText(handle, key, &buffer, UInt(byteCount))
        let text = String(decoding: buffer.dropLast(), as: UTF16.self)
        return text.isEmpty ? nil : text
    }

    /// Parses a PDF date string: `D:YYYYMMDDHHmmSS` with an optional timezone suffix.
    static func parsePdfDate(_ raw: String) -> Date? {
        var s = raw
        if s.hasPrefix("D:") { s.removeFirst(2) }
        let digits = s.prefix(while: \.isNumber)
        guard digits.count >= 8 else { return nil }

        func part(_ start: Int, _ length: Int) -> Int? {
            guard digits.count >= start + length else { return nil }
            let from = digits.index(digits.startIndex, offsetBy: start)
            let to = digits.index(from, offsetBy: length)
            return Int(digits[from..<to])
        }

        var components = DateComponents()
        components.year = part(0, 4)
        components.month = part(4, 2)
        components.day = part(6, 2)
        components.hour = part(8, 2) ?? 0
        components.minute = part(10, 2) ?? 0
        components.second = part(12, 2) ?? 0

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar.date(from: components)
    }
}
