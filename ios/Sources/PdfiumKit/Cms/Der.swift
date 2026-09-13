import Foundation

/// Just enough DER to walk a PKCS#7 SignedData.
///
/// This runs on untrusted input — a signature blob out of an arbitrary PDF — so
/// malformed data is the expected case, not the exceptional one. Every read
/// bounds-checks before it indexes, and anything it cannot make sense of throws rather
/// than returning a guess.
///
/// Deliberately narrow: no encoding, no schema, no types beyond the handful the CMS walk
/// needs. It is not a general ASN.1 library and should not become one.
enum Der {
    struct Tlv {
        /// Identifier octet, e.g. 0x30 SEQUENCE, 0x31 SET, 0xa0 [0] constructed.
        let tag: UInt8
        /// Offset of the identifier octet, so the whole encoding can be taken verbatim.
        let start: Int
        let length: Int
        let contentStart: Int
        let contentEnd: Int
        var end: Int { contentEnd }
    }

    struct Failure: Error, CustomStringConvertible {
        let reason: String
        var description: String { "DER: \(reason)" }
    }

    static func isConstructed(_ tag: UInt8) -> Bool { tag & 0x20 != 0 }

    static func readTlv(_ bytes: [UInt8], _ offset: Int) throws -> Tlv {
        guard offset >= 0, offset < bytes.count else {
            throw Failure(reason: "truncated: no tag at offset \(offset)")
        }

        var cursor = offset
        let tag = bytes[cursor]; cursor += 1

        // High-tag-number form: the low five bits are all set and the number continues
        // in following octets. Nothing in CMS uses it, so it is refused rather than
        // half-read.
        guard tag & 0x1f != 0x1f else {
            throw Failure(reason: "high-tag-number form is not supported")
        }
        guard cursor < bytes.count else { throw Failure(reason: "truncated: no length octet") }
        let first = bytes[cursor]; cursor += 1

        let length: Int
        if first < 0x80 {
            length = Int(first)
        } else if first == 0x80 {
            // Permitted in BER, forbidden in DER. Accepting it would mean scanning for
            // an end-of-contents marker, which is exactly the unbounded read to avoid.
            throw Failure(reason: "indefinite length is not valid DER")
        } else {
            let count = Int(first & 0x7f)
            guard count <= 4 else { throw Failure(reason: "length of \(count) octets is implausible") }
            guard cursor + count <= bytes.count else { throw Failure(reason: "truncated: length octets") }
            var value = 0
            for _ in 0..<count { value = value * 256 + Int(bytes[cursor]); cursor += 1 }
            length = value
        }

        let contentStart = cursor
        let contentEnd = contentStart + length
        guard contentEnd <= bytes.count else {
            throw Failure(reason: "truncated: value of \(length) bytes runs past the buffer")
        }
        return Tlv(tag: tag, start: offset, length: length,
                   contentStart: contentStart, contentEnd: contentEnd)
    }

    /// The immediate children of a constructed value; empty for a primitive one.
    static func children(_ bytes: [UInt8], _ tlv: Tlv) throws -> [Tlv] {
        guard isConstructed(tlv.tag) else { return [] }

        var out: [Tlv] = []
        var cursor = tlv.contentStart
        while cursor < tlv.contentEnd {
            let child = try readTlv(bytes, cursor)
            guard child.end <= tlv.contentEnd else {
                throw Failure(reason: "child runs past its parent")
            }
            guard child.end > cursor else {
                throw Failure(reason: "zero-width child would not terminate")
            }
            out.append(child)
            cursor = child.end
        }
        return out
    }

    /// Decodes an OBJECT IDENTIFIER to dotted form.
    ///
    /// The first octet packs two arcs as `40 * first + second`, which is why 1.2 and
    /// 2.16 encode so differently — the second arc is unbounded once the first is 2.
    static func readOid(_ bytes: [UInt8], _ tlv: Tlv) throws -> String {
        guard tlv.length > 0 else { throw Failure(reason: "empty OID") }

        var arcs: [Int] = []
        var value = 0
        var started = false

        for i in tlv.contentStart..<tlv.contentEnd {
            let byte = bytes[i]
            value = value * 128 + Int(byte & 0x7f)
            if byte & 0x80 != 0 { continue }

            if !started {
                let first = min(value / 40, 2)
                arcs.append(first)
                arcs.append(value - first * 40)
                started = true
            } else {
                arcs.append(value)
            }
            value = 0
        }

        guard value == 0 else { throw Failure(reason: "OID ends mid-arc") }
        return arcs.map(String.init).joined(separator: ".")
    }

    /// INTEGER as unsigned big-endian bytes, since certificate serials exceed 64 bits.
    static func readIntegerBytes(_ bytes: [UInt8], _ tlv: Tlv) throws -> [UInt8] {
        guard tlv.length > 0 else { throw Failure(reason: "empty INTEGER") }
        var value = Array(bytes[tlv.contentStart..<tlv.contentEnd])
        // DER prefixes a zero octet when the high bit would otherwise mean negative.
        while value.count > 1 && value[0] == 0 { value.removeFirst() }
        return value
    }

    static func content(_ bytes: [UInt8], _ tlv: Tlv) -> [UInt8] {
        Array(bytes[tlv.contentStart..<tlv.contentEnd])
    }

    /// The whole triple including tag and length, which is what signatures cover.
    static func encoding(_ bytes: [UInt8], _ tlv: Tlv) -> [UInt8] {
        Array(bytes[tlv.start..<tlv.end])
    }
}
