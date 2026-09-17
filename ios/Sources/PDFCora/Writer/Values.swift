import Foundation

/// A PDF value, for writing only. Nothing here parses.
///
/// PDFium cannot create dictionaries, so anything this SDK must write into a document —
/// a signature dictionary, a replacement `/Info` — is built here and appended as an
/// incremental update.
public indirect enum PdfValue: Sendable {
    case null
    case boolean(Bool)
    case integer(Int)
    case real(Double)
    case string(String)
    case name(String)
    case hexString(Data)
    case reference(Int, generation: Int = 0)
    case array([PdfValue])
    /// Ordered: PDF readers do not care, but stable output makes diffs and tests legible.
    case dictionary([(String, PdfValue)])
    /// Bytes written verbatim, for stream bodies, which are not PDF values.
    case raw(Data)

    public static func serialize(_ value: PdfValue, objectNumber: Int? = nil,
                                 generation: Int = 0) -> Data {
        let body = encode(value)
        guard let objectNumber else { return body }
        var out = Data("\(objectNumber) \(generation) obj\n".utf8)
        out.append(body)
        out.append(Data("\nendobj\n".utf8))
        return out
    }

    private static func encode(_ value: PdfValue) -> Data {
        switch value {
        case .null: return Data("null".utf8)
        case .boolean(let flag): return Data((flag ? "true" : "false").utf8)
        case .integer(let number): return Data(String(number).utf8)
        case .real(let number):
            let rounded = (number * 1_000_000).rounded() / 1_000_000
            return Data((rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)).utf8)
        case .string(let text): return encodeString(text)
        case .name(let text): return Data(encodeName(text).utf8)
        case .hexString(let bytes):
            var out = Data("<".utf8); out.append(hex(bytes)); out.append(Data(">".utf8)); return out
        case .reference(let number, let generation):
            return Data("\(number) \(generation) R".utf8)
        case .array(let items):
            var out = Data("[".utf8)
            for (index, item) in items.enumerated() {
                if index > 0 { out.append(0x20) }
                out.append(encode(item))
            }
            out.append(Data("]".utf8))
            return out
        case .dictionary(let entries):
            var out = Data("<<".utf8)
            for (index, entry) in entries.enumerated() {
                if index > 0 { out.append(0x20) }
                out.append(Data(encodeName(entry.0).utf8))
                out.append(0x20)
                out.append(encode(entry.1))
            }
            out.append(Data(">>".utf8))
            return out
        case .raw(let bytes): return bytes
        }
    }

    /// A name is terminated by whitespace or a delimiter, so those bytes are escaped
    /// rather than written literally.
    private static func encodeName(_ value: String) -> String {
        var out = "/"
        for scalar in value.unicodeScalars {
            let safe = scalar.value > 0x20 && scalar.value < 0x7f
                && !"()<>[]{}/%#".unicodeScalars.contains(scalar)
            out += safe ? String(scalar)
                        : "#" + String(format: "%02X", scalar.value)
        }
        return out
    }

    private static func encodeString(_ value: String) -> Data {
        // PDF text strings are PDFDocEncoding unless they open with a UTF-16BE byte
        // order mark. Rather than model PDFDocEncoding, anything outside ASCII takes
        // the BOM path.
        if value.unicodeScalars.contains(where: { $0.value > 0x7f }) {
            var bytes = Data([0xfe, 0xff])
            for unit in Array(value.utf16) {
                bytes.append(UInt8(unit >> 8)); bytes.append(UInt8(unit & 0xff))
            }
            var out = Data("<".utf8); out.append(hex(bytes)); out.append(Data(">".utf8))
            return out
        }
        var escaped = ""
        for character in value {
            switch character {
            case "\\": escaped += "\\\\"
            case "(": escaped += "\\("
            case ")": escaped += "\\)"
            case "\r": escaped += "\\r"
            case "\n": escaped += "\\n"
            case "\t": escaped += "\\t"
            default: escaped.append(character)
            }
        }
        return Data("(\(escaped))".utf8)
    }

    private static func hex(_ bytes: Data) -> Data {
        var out = Data(capacity: bytes.count * 2)
        for byte in bytes {
            out.append(hexDigits[Int(byte >> 4)])
            out.append(hexDigits[Int(byte & 0x0f)])
        }
        return out
    }
    private static let hexDigits = Array(Data("0123456789ABCDEF".utf8))
}
