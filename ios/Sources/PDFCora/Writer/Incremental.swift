import Foundation

/// Appending an incremental update.
///
/// The original bytes are never touched: new and replaced objects are written after
/// them, followed by a cross-reference section listing only what changed and a trailer
/// whose `/Prev` points at the previous section. A reader that follows the chain sees
/// the new objects; the old file is intact underneath, which is what lets an earlier
/// signature keep verifying.
public enum PdfWriter {
    public static func appendUpdate(
        to base: Data,
        objects: [Int: PdfValue],
        trailer extra: [(String, PdfValue)] = []
    ) throws -> Data {
        let info = try TrailerInfo.scan(base)
        var out = base
        var offset = base.count

        // A generating application may omit the final newline; without one the first
        // appended object would run into %%EOF.
        if let last = base.last, last != 0x0a, last != 0x0d {
            out.append(0x0a); offset += 1
        }

        var positions: [Int: Int] = [:]
        for number in objects.keys.sorted() {
            positions[number] = offset
            let bytes = PdfValue.serialize(objects[number]!, objectNumber: number)
            out.append(bytes)
            offset += bytes.count
        }

        let highest = positions.keys.max() ?? (info.size - 1)
        let size = max(info.size, highest + 1)

        out.append(info.style == .table
            ? xrefTable(positions, size: size, info: info, at: offset, extra: extra)
            : xrefStream(positions, size: size, info: info, at: offset, extra: extra))
        return out
    }

    private static func trailerEntries(
        size: Int, info: TrailerInfo, extra: [(String, PdfValue)]
    ) -> [(String, PdfValue)] {
        var entries: [(String, PdfValue)] = [
            ("Size", .integer(size)), ("Root", info.root), ("Prev", .integer(info.startXref)),
        ]
        if let value = info.info { entries.append(("Info", value)) }
        if let value = info.id { entries.append(("ID", value)) }
        let overridden = Set(extra.map(\.0))
        return entries.filter { !overridden.contains($0.0) } + extra
    }

    /// Classic cross-reference table. Entries are grouped into runs of consecutive
    /// object numbers, and each line is exactly 20 bytes.
    private static func xrefTable(
        _ positions: [Int: Int], size: Int, info: TrailerInfo, at xrefOffset: Int,
        extra: [(String, PdfValue)]
    ) -> Data {
        let numbers = positions.keys.sorted()
        var table = "xref\n"
        var i = 0
        while i < numbers.count {
            var end = i + 1
            while end < numbers.count && numbers[end] == numbers[end - 1] + 1 { end += 1 }
            table += "\(numbers[i]) \(end - i)\n"
            for j in i..<end {
                table += String(format: "%010d 00000 n \n", positions[numbers[j]]!)
            }
            i = end
        }

        var out = Data(table.utf8)
        out.append(Data("trailer\n".utf8))
        out.append(PdfValue.serialize(.dictionary(trailerEntries(size: size, info: info, extra: extra))))
        out.append(Data("\nstartxref\n\(xrefOffset)\n%%EOF\n".utf8))
        return out
    }

    /// Cross-reference stream, for files written that way. The stream is its own object,
    /// so it occupies a number and appears in its own table. Fields are uncompressed —
    /// `/Filter` is omitted — because the saving is irrelevant for a handful of entries
    /// and an undecodable stream is a much worse failure than a large one.
    private static func xrefStream(
        _ positions: [Int: Int], size: Int, info: TrailerInfo, at xrefOffset: Int,
        extra: [(String, PdfValue)]
    ) -> Data {
        let streamNumber = size
        var all = positions
        all[streamNumber] = xrefOffset

        let numbers = all.keys.sorted()
        var index: [PdfValue] = []
        var body = Data()
        var i = 0
        while i < numbers.count {
            var end = i + 1
            while end < numbers.count && numbers[end] == numbers[end - 1] + 1 { end += 1 }
            index.append(.integer(numbers[i]))
            index.append(.integer(end - i))
            for j in i..<end {
                let position = all[numbers[j]]!
                // /W [1 4 2]: type, a four-byte offset, a two-byte generation.
                body.append(1)
                body.append(UInt8((position >> 24) & 0xff))
                body.append(UInt8((position >> 16) & 0xff))
                body.append(UInt8((position >> 8) & 0xff))
                body.append(UInt8(position & 0xff))
                body.append(0); body.append(0)
            }
            i = end
        }

        let dictionary: [(String, PdfValue)] =
            trailerEntries(size: streamNumber + 1, info: info, extra: extra) + [
                ("Type", .name("XRef")),
                ("W", .array([.integer(1), .integer(4), .integer(2)])),
                ("Index", .array(index)),
                ("Length", .integer(body.count)),
            ]

        var out = Data("\(streamNumber) 0 obj\n".utf8)
        out.append(PdfValue.serialize(.dictionary(dictionary)))
        out.append(Data("\nstream\n".utf8))
        out.append(body)
        out.append(Data("\nendstream\nendobj\n".utf8))
        out.append(Data("startxref\n\(xrefOffset)\n%%EOF\n".utf8))
        return out
    }
}
