import Foundation

/// Finds a model's quote in the source text and returns its UTF-16 range there (ANS-3).
///
/// Tolerates what text extraction legitimately changes — runs of whitespace, line breaks,
/// and words hyphenated across a line — and nothing else. Wording, punctuation and case
/// must match, because a quote that differs in those was not copied, and a highlight built
/// from it would point at text that does not say what the answer claims.
public func locateQuote(in source: String, _ quote: String) -> Range<Int>? {
    let needle = normalise(Array(quote.utf16), keepHyphen: true).units
    guard !needle.isEmpty else { return nil }
    // A hyphen at a line end is either hyphenation ("manage-\nment") or a compound that
    // happens to break there ("well-\nknown"). The text cannot say which, so try both.
    for keepHyphen in [false, true] {
        let haystack = normalise(Array(source.utf16), keepHyphen: keepHyphen)
        if let at = firstIndex(of: needle, in: haystack.units) {
            return haystack.origin[at]..<(haystack.origin[at + needle.count - 1] + 1)
        }
    }
    return nil
}

private func normalise(_ text: [UInt16], keepHyphen: Bool) -> (units: [UInt16], origin: [Int]) {
    let space: UInt16 = 0x20, hyphen: UInt16 = 0x2D, softHyphen: UInt16 = 0xAD
    var out: [UInt16] = []
    var origin: [Int] = []
    var i = 0
    while i < text.count {
        let c = text[i]
        if c == softHyphen { i += 1; continue }
        if c == hyphen, let last = out.last, isLetter(last) {
            var j = i + 1
            while j < text.count, text[j] == 0x20 || text[j] == 0x09 { j += 1 }
            if j < text.count, text[j] == 0x0D || text[j] == 0x0A {
                if keepHyphen { out.append(c); origin.append(i) }
                while j < text.count, TextLayer.isSpace(text[j]) { j += 1 }
                i = j
                continue
            }
        }
        if TextLayer.isSpace(c) {
            if let last = out.last, last != space { out.append(space); origin.append(i) }
            i += 1
            continue
        }
        out.append(c)
        origin.append(i)
        i += 1
    }
    if out.last == space { out.removeLast(); origin.removeLast() }
    return (out, origin)
}

private func isLetter(_ unit: UInt16) -> Bool {
    guard let scalar = Unicode.Scalar(unit) else { return false }
    return scalar.properties.isAlphabetic
}

private func firstIndex(of needle: [UInt16], in haystack: [UInt16]) -> Int? {
    guard needle.count <= haystack.count else { return nil }
    outer: for start in 0...(haystack.count - needle.count) {
        for offset in 0..<needle.count where haystack[start + offset] != needle[offset] { continue outer }
        return start
    }
    return nil
}
