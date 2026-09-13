import Foundation

/// A minimal dictionary reader.
///
/// It understands the value forms that appear in a trailer — numbers, names,
/// references, arrays, strings and nested dictionaries — and preserves nothing else,
/// because nothing else is carried forward into the update.
struct PdfDictionaryReader {
    private let text: String
    private let characters: [Character]

    init(_ text: String) {
        self.text = text
        self.characters = Array(text)
    }

    func read(from index: String.Index) throws -> [String: PdfValue] {
        let start = text.distance(from: text.startIndex, to: index)
        return try readDictionary(at: start).value
    }

    private func readDictionary(at start: Int) throws -> (value: [String: PdfValue], next: Int) {
        guard peek(start) == "<", peek(start + 1) == "<" else {
            throw PdfError.saveFailed(reason: "expected a dictionary")
        }
        var result: [String: PdfValue] = [:]
        var i = skipSpace(start + 2)

        while true {
            if peek(i) == ">" && peek(i + 1) == ">" { return (result, i + 2) }
            guard i < characters.count else {
                throw PdfError.saveFailed(reason: "unterminated dictionary")
            }
            guard peek(i) == "/" else {
                throw PdfError.saveFailed(reason: "expected a key at \(i)")
            }
            let keyEnd = endOfToken(i + 1)
            let key = decodeName(String(characters[(i + 1)..<keyEnd]))
            let parsed = try readValue(at: skipSpace(keyEnd))
            result[key] = parsed.value
            i = skipSpace(parsed.next)
        }
    }

    private func readValue(at start: Int) throws -> (value: PdfValue, next: Int) {
        let i = skipSpace(start)
        switch peek(i) {
        case "<" where peek(i + 1) == "<":
            let nested = try readDictionary(at: i)
            return (.dictionary(nested.value.map { ($0.key, $0.value) }), nested.next)
        case "<":
            var end = i
            while end < characters.count && characters[end] != ">" { end += 1 }
            let digits = String(characters[(i + 1)..<end]).filter { $0.isHexDigit }
            return (.hexString(Data(hexPairs: digits)), end + 1)
        case "[":
            var items: [PdfValue] = []
            var j = skipSpace(i + 1)
            while true {
                if peek(j) == "]" { return (.array(items), j + 1) }
                guard j < characters.count else {
                    throw PdfError.saveFailed(reason: "unterminated array")
                }
                let item = try readValue(at: j)
                items.append(item.value)
                j = skipSpace(item.next)
            }
        case "(":
            var depth = 0
            var j = i
            while j < characters.count {
                if characters[j] == "\\" { j += 2; continue }
                if characters[j] == "(" { depth += 1 }
                else if characters[j] == ")" { depth -= 1; if depth == 0 { j += 1; break } }
                j += 1
            }
            return (.string(String(characters[(i + 1)..<max(i + 1, j - 1)])), j)
        case "/":
            let end = endOfToken(i + 1)
            return (.name(decodeName(String(characters[(i + 1)..<end]))), end)
        default:
            break
        }

        // "12 0 R" is a reference; "12 0" on its own is two numbers. Only the
        // three-token form may be consumed here, or array elements get swallowed.
        if let reference = Self.reference.firstMatch(
            in: text, range: NSRange(location: i, length: min(32, characters.count - i))),
           reference.range.location == i {
            let numbers = (1...2).map { Int(substring(reference.range(at: $0))) ?? 0 }
            return (.reference(numbers[0], generation: numbers[1]), i + reference.range.length)
        }

        let end = endOfToken(i)
        let token = String(characters[i..<end])
        switch token {
        case "true": return (.boolean(true), end)
        case "false": return (.boolean(false), end)
        case "null": return (.null, end)
        default: break
        }
        if let integer = Int(token) { return (.integer(integer), end) }
        if let real = Double(token) { return (.real(real), end) }
        throw PdfError.saveFailed(reason: "unrecognised token \"\(token)\"")
    }

    private static let reference = try! NSRegularExpression(pattern: #"\A(\d+)\s+(\d+)\s+R\b"#)

    private func substring(_ range: NSRange) -> String {
        guard let r = Range(range, in: text) else { return "" }
        return String(text[r])
    }

    private func peek(_ index: Int) -> Character? {
        index >= 0 && index < characters.count ? characters[index] : nil
    }

    private func skipSpace(_ start: Int) -> Int {
        var i = start
        while true {
            while i < characters.count,
                  characters[i].isWhitespace || characters[i] == "\0" { i += 1 }
            guard peek(i) == "%" else { return i }   // comments run to end of line
            while i < characters.count, characters[i] != "\n", characters[i] != "\r" { i += 1 }
        }
    }

    private func endOfToken(_ start: Int) -> Int {
        var i = start
        while i < characters.count,
              !characters[i].isWhitespace,
              !"()<>[]{}/%".contains(characters[i]) { i += 1 }
        return i
    }

    private func decodeName(_ value: String) -> String {
        var out = ""
        var characters = Array(value)
        var i = 0
        while i < characters.count {
            if characters[i] == "#", i + 2 < characters.count,
               let code = UInt8(String(characters[(i + 1)...(i + 2)]), radix: 16) {
                out.append(Character(UnicodeScalar(code)))
                i += 3
            } else {
                out.append(characters[i])
                i += 1
            }
        }
        return out
    }
}

private extension Data {
    init(hexPairs digits: String) {
        var bytes: [UInt8] = []
        var characters = Array(digits)
        if characters.count % 2 == 1 { characters.append("0") }
        for i in stride(from: 0, to: characters.count, by: 2) {
            bytes.append(UInt8(String(characters[i...(i + 1)]), radix: 16) ?? 0)
        }
        self.init(bytes)
    }
}
