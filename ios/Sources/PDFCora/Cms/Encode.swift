import Foundation

/// Writing DER.
///
/// Only what embedding a timestamp needs: a timestamp request to send, and the nested
/// wrappers that have to be re-encoded to put the returned token into a SignerInfo's
/// unsigned attributes. Kept separate from ``Der``, which stays read-only.
enum DerEncode {
    enum Tag {
        static let boolean: UInt8 = 0x01
        static let integer: UInt8 = 0x02
        static let octetString: UInt8 = 0x04
        static let oid: UInt8 = 0x06
        static let sequence: UInt8 = 0x30
        static let set: UInt8 = 0x31
        static let context0: UInt8 = 0xa0
        static let context1: UInt8 = 0xa1
    }

    /// One tag-length-value triple, using the shortest legal length form.
    static func tlv(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
        [tag] + length(content.count) + content
    }

    private static func length(_ value: Int) -> [UInt8] {
        if value < 0x80 { return [UInt8(value)] }

        var octets: [UInt8] = []
        var remaining = value
        while remaining > 0 {
            octets.insert(UInt8(remaining % 256), at: 0)
            remaining /= 256
        }
        // DER requires the minimum number of octets, which building from the value gives.
        return [0x80 | UInt8(octets.count)] + octets
    }

    static func sequence(_ parts: [UInt8]...) -> [UInt8] { tlv(Tag.sequence, parts.flatMap { $0 }) }
    static func set(_ parts: [UInt8]...) -> [UInt8] { tlv(Tag.set, parts.flatMap { $0 }) }
    static func octetString(_ bytes: [UInt8]) -> [UInt8] { tlv(Tag.octetString, bytes) }
    static func boolean(_ value: Bool) -> [UInt8] { tlv(Tag.boolean, [value ? 0xff : 0x00]) }

    /// A non-negative INTEGER, with the leading zero DER requires when the top bit is set.
    static func integer(_ value: Int) -> [UInt8] {
        precondition(value >= 0, "negative integers are not supported")
        var bytes: [UInt8] = []
        var remaining = value
        repeat {
            bytes.insert(UInt8(remaining % 256), at: 0)
            remaining /= 256
        } while remaining > 0
        if bytes[0] & 0x80 != 0 { bytes.insert(0, at: 0) }
        return tlv(Tag.integer, bytes)
    }

    static func integer(_ value: [UInt8]) -> [UInt8] {
        var bytes = value
        while bytes.count > 1 && bytes[0] == 0 { bytes.removeFirst() }
        if bytes.first.map({ $0 & 0x80 != 0 }) == true { bytes.insert(0, at: 0) }
        return tlv(Tag.integer, bytes)
    }

    /// A dotted OID, packing the first two arcs as `40 * first + second`.
    static func oid(_ dotted: String) -> [UInt8] {
        let arcs = dotted.split(separator: ".").compactMap { Int($0) }
        precondition(arcs.count >= 2, "bad OID \(dotted)")

        var bytes: [UInt8] = [UInt8(arcs[0] * 40 + arcs[1])]
        for arc in arcs.dropFirst(2) {
            var septets: [UInt8] = []
            var remaining = arc
            repeat {
                septets.insert(UInt8(remaining & 0x7f), at: 0)
                remaining >>= 7
            } while remaining > 0
            for i in 0..<(septets.count - 1) { septets[i] |= 0x80 }
            bytes += septets
        }
        return tlv(Tag.oid, bytes)
    }
}
