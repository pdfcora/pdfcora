import Compression
import Foundation

/// Flate decompression.
///
/// Needed because a cross-reference stream and the object streams it points into are
/// both compressed, and one corpus document keeps its Catalog inside one.
///
/// Apple's Compression framework implements raw DEFLATE (RFC 1951), not the zlib
/// wrapper (RFC 1950), so the two-byte header is skipped here rather than being handed
/// to a decoder that would reject it.
enum Inflate {
    struct Failure: Error, CustomStringConvertible {
        let reason: String
        var description: String { "inflate: \(reason)" }
    }

    static func inflate(_ bytes: [UInt8]) throws -> [UInt8] {
        if bytes.isEmpty { throw Failure(reason: "empty stream") }

        // A zlib header is CMF/FLG where CMF low nibble is 8 (deflate) and the pair is
        // a multiple of 31. Anything else is treated as raw.
        let looksZlib = bytes.count > 2
            && (bytes[0] & 0x0f) == 8
            && (Int(bytes[0]) << 8 | Int(bytes[1])) % 31 == 0

        if let out = raw(Array(bytes.dropFirst(looksZlib ? 2 : 0))) { return out }
        if looksZlib, let out = raw(bytes) { return out }
        throw Failure(reason: "the stream could not be decompressed")
    }

    private static func raw(_ bytes: [UInt8]) -> [UInt8]? {
        guard !bytes.isEmpty else { return nil }

        // The decompressed size is unknown, so grow until the whole input is consumed.
        var capacity = max(bytes.count * 8, 1 << 16)
        for _ in 0..<8 {
            var out = [UInt8](repeating: 0, count: capacity)
            let written = bytes.withUnsafeBufferPointer { source in
                out.withUnsafeMutableBufferPointer { destination in
                    compression_decode_buffer(
                        destination.baseAddress!, capacity,
                        source.baseAddress!, bytes.count,
                        nil, COMPRESSION_ZLIB)
                }
            }
            if written == 0 { return nil }
            // A full buffer may mean truncation rather than an exact fit, so retry larger.
            if written < capacity { return Array(out.prefix(written)) }
            capacity *= 4
        }
        return nil
    }

    /// Undoes a PNG predictor.
    ///
    /// Cross-reference streams are routinely written with `/Predictor 12`, which makes
    /// each row a delta against the one above. Inflating without undoing it yields
    /// plausible-looking bytes and completely wrong offsets — a failure that shows up as
    /// "object not found" rather than as a decode error.
    static func undoPredictor(
        _ data: [UInt8], predictor: Int, columns: Int, colors: Int = 1, bitsPerComponent: Int = 8
    ) throws -> [UInt8] {
        if predictor <= 1 { return data }
        if predictor < 10 {
            throw Failure(reason: "TIFF predictor \(predictor) is not supported")
        }

        let pixel = max(1, (colors * bitsPerComponent + 7) / 8)
        let rowLength = (columns * colors * bitsPerComponent + 7) / 8
        let stride = rowLength + 1                  // each row carries a leading filter byte
        guard stride > 1 else { throw Failure(reason: "zero-width predictor rows") }
        let rows = data.count / stride

        var out = [UInt8]()
        out.reserveCapacity(rows * rowLength)
        var previous = [UInt8](repeating: 0, count: rowLength)

        for row in 0..<rows {
            let type = data[row * stride]
            var current = [UInt8](repeating: 0, count: rowLength)

            for i in 0..<rowLength {
                let rawByte = Int(data[row * stride + 1 + i])
                let left = i >= pixel ? Int(current[i - pixel]) : 0
                let up = Int(previous[i])
                let upLeft = i >= pixel ? Int(previous[i - pixel]) : 0

                let value: Int
                switch type {
                case 0: value = rawByte                                   // None
                case 1: value = rawByte + left                            // Sub
                case 2: value = rawByte + up                              // Up
                case 3: value = rawByte + (left + up) / 2                 // Average
                case 4: value = rawByte + paeth(left, up, upLeft)         // Paeth
                default: throw Failure(reason: "unknown PNG filter type \(type)")
                }
                current[i] = UInt8(value & 0xff)
            }

            out += current
            previous = current
        }
        return out
    }

    private static func paeth(_ left: Int, _ up: Int, _ upLeft: Int) -> Int {
        let estimate = left + up - upLeft
        let dl = abs(estimate - left), du = abs(estimate - up), dul = abs(estimate - upLeft)
        if dl <= du && dl <= dul { return left }
        return du <= dul ? up : upLeft
    }
}
