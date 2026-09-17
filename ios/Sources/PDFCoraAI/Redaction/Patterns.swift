import Foundation

public enum PdfRedactionCategory: String, CaseIterable, Sendable {
    case iban, email, phone, paymentCard, date, url, ipAddress
    case personName, postalAddress, dateOfBirth, idNumber

    /// Found by pattern, in tie-break order.
    public static let patterns: [PdfRedactionCategory] = [.iban, .email, .phone, .paymentCard, .date, .url, .ipAddress]
    /// Found by a model.
    public static let model: [PdfRedactionCategory] = [.personName, .postalAddress, .dateOfBirth, .idNumber]
}

struct PatternMatch: Equatable {
    let category: PdfRedactionCategory
    let range: Range<Int>
}

/// Personal data found by pattern alone (RED-1). Behaviour is pinned by
/// conformance/redaction/patterns.json, which every platform runs. Offsets are UTF-16.
enum Patterns {
    private typealias Accept = (_ text: NSString, _ range: Range<Int>) -> Range<Int>?

    private static let months: [String: Int] = [
        "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6, "July": 7, "August": 8,
        "September": 9, "October": 10, "November": 11, "December": 12,
        "Januar": 1, "Februar": 2, "März": 3, "Mai": 5, "Juni": 6, "Juli": 7, "Oktober": 10, "Dezember": 12,
        "Sept": 9, "Jan": 1, "Feb": 2, "Mar": 3, "Mär": 3, "Apr": 4, "Jun": 6, "Jul": 7, "Aug": 8, "Sep": 9,
        "Oct": 10, "Okt": 10, "Nov": 11, "Dec": 12, "Dez": 12, "Jän": 1,
    ]
    private static let month = months.keys.sorted { $0.count > $1.count }.joined(separator: "|")
    private static let hex = "[0-9A-Fa-f]{1,4}"

    private static let rules: [(PdfRedactionCategory, NSRegularExpression, Accept)] = [
        (.iban, regex("[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}"), acceptIban),
        (.email, regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), acceptEmail),
        (.phone, regex("\\+[0-9]{1,3}(?:[ .\\-/]?\\(?[0-9]{1,4}\\)?){2,6}"), acceptPhone),
        (.phone, regex("\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-][0-9]{4}"), acceptPhone),
        (.phone, regex("0[0-9]{2,4}(?:[ /-]?[0-9]{2,8}){1,3}"), acceptPhone),
        (.paymentCard, regex("[0-9](?:[ -]?[0-9]){12,18}"), acceptCard),
        (.date, regex("[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\\.[0-9]{1,2}\\.(?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}"), acceptDate),
        (.date, regex("[0-9]{1,2}\\.? (?:\(month))\\.? [0-9]{4}|(?:\(month))\\.? [0-9]{1,2},? [0-9]{4}"), acceptDate),
        (.url, regex("https?://[^\\s<>\"]+|www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?:/[^\\s<>\"]*)?"), acceptUrl),
        (.ipAddress, regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}"), acceptIp),
        (.ipAddress, regex("(?:\(hex):){7}\(hex)|(?:\(hex):){1,7}:(?:\(hex)(?::\(hex)){0,6})?|::\(hex)(?::\(hex)){0,6}"), acceptIp),
    ]

    private static func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }

    static func find(in string: String, categories: Set<PdfRedactionCategory>? = nil) -> [PatternMatch] {
        let text = NSString(string: string)
        var candidates: [PatternMatch] = []
        for (category, regex, accept) in rules where categories?.contains(category) ?? true {
            var from = 0
            while from < text.length,
                  let match = regex.firstMatch(in: string, range: NSRange(location: from, length: text.length - from)) {
                let range = match.range.location..<(match.range.location + match.range.length)
                if let accepted = accept(text, range) { candidates.append(PatternMatch(category: category, range: accepted)) }
                // A rejected match may hide a valid one starting one character later.
                from = match.range.location + 1
            }
        }
        let order = { (c: PdfRedactionCategory) in PdfRedactionCategory.patterns.firstIndex(of: c)! }
        candidates.sort {
            $0.range.count != $1.range.count ? $0.range.count > $1.range.count
                : order($0.category) != order($1.category) ? order($0.category) < order($1.category)
                : $0.range.lowerBound < $1.range.lowerBound
        }
        var chosen: [PatternMatch] = []
        for c in candidates where !chosen.contains(where: { c.range.overlaps($0.range) }) { chosen.append(c) }
        return chosen.sorted { $0.range.lowerBound < $1.range.lowerBound }
    }

    // MARK: - Validators

    private static func char(_ text: NSString, _ i: Int) -> String? {
        i >= 0 && i < text.length ? text.substring(with: NSRange(location: i, length: 1)) : nil
    }
    private static func isWord(_ text: NSString, _ i: Int) -> Bool {
        guard i >= 0, i < text.length, let scalar = UnicodeScalar(text.character(at: i)) else { return false }
        return CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)
    }
    private static func sub(_ text: NSString, _ range: Range<Int>) -> String {
        let lower = max(0, range.lowerBound), upper = min(text.length, range.upperBound)
        return lower < upper ? text.substring(with: NSRange(location: lower, length: upper - lower)) : ""
    }
    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private static func continuesBefore(_ text: NSString, _ start: Int) -> Bool { matches(sub(text, (start - 2)..<start), "[0-9][ .\\-/]$") }
    private static func continuesAfter(_ text: NSString, _ end: Int) -> Bool { matches(sub(text, end..<(end + 2)), "^[ .\\-/][0-9]") }

    private static func mod97(_ iban: String) -> Int {
        let chars = Array(iban)
        var remainder = 0
        for ch in chars[4...] + chars[..<4] {
            let value = ch.isLetter ? String(Int(ch.asciiValue!) - 55) : String(ch)
            for digit in value { remainder = (remainder * 10 + Int(String(digit))!) % 97 }
        }
        return remainder
    }

    private static func luhn(_ digits: [Int]) -> Bool {
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            var v = d
            if i % 2 == 1 { v *= 2; if v > 9 { v -= 9 } }
            sum += v
        }
        return sum % 10 == 0
    }

    private static func validDate(_ year: Int, _ month: Int, _ day: Int) -> Bool {
        guard (1...12).contains(month), day >= 1 else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    }

    private static let acceptIban: Accept = { text, range in
        guard !isWord(text, range.lowerBound - 1) else { return nil }
        let positions = range.filter { matches(sub(text, $0..<($0 + 1)), "^[A-Z0-9]$") }
        for k in stride(from: min(34, positions.count), through: 15, by: -1) {
            let stop = positions[k - 1] + 1
            if isWord(text, stop) { continue }
            if mod97(positions[..<k].map { sub(text, $0..<($0 + 1)) }.joined()) == 1 { return range.lowerBound..<stop }
        }
        return nil
    }

    private static let acceptEmail: Accept = { text, range in
        matches(char(text, range.lowerBound - 1) ?? "", "^[A-Za-z0-9._%+-]$") || isWord(text, range.upperBound) ? nil : range
    }

    private static let acceptPhone: Accept = { text, range in
        if isWord(text, range.lowerBound - 1) || char(text, range.lowerBound - 1) == "+" || isWord(text, range.upperBound) { return nil }
        if continuesBefore(text, range.lowerBound) || continuesAfter(text, range.upperBound) { return nil }
        let digits = sub(text, range).filter(\.isNumber).count
        return (7...15).contains(digits) ? range : nil
    }

    private static let acceptCard: Accept = { text, range in
        if isWord(text, range.lowerBound - 1) || isWord(text, range.upperBound) { return nil }
        if continuesBefore(text, range.lowerBound) || continuesAfter(text, range.upperBound) { return nil }
        let digits = sub(text, range).compactMap(\.wholeNumberValue)
        return (13...19).contains(digits.count) && luhn(digits) ? range : nil
    }

    private static let acceptDate: Accept = { text, range in
        if isWord(text, range.lowerBound - 1) || isWord(text, range.upperBound) || continuesAfter(text, range.upperBound) { return nil }
        let s = sub(text, range)
        func groups(_ pattern: String) -> [String]? {
            guard let m = try! NSRegularExpression(pattern: pattern).firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) else { return nil }
            return (1..<m.numberOfRanges).map { (s as NSString).substring(with: m.range(at: $0)) }
        }
        if let g = groups("^([0-9]{4})-([0-9]{2})-([0-9]{2})$") { return validDate(Int(g[0])!, Int(g[1])!, Int(g[2])!) ? range : nil }
        if let g = groups("^([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{2}|[0-9]{4})$") {
            let year = g[2].count == 2 ? 2000 + Int(g[2])! : Int(g[2])!
            return validDate(year, Int(g[1])!, Int(g[0])!) ? range : nil
        }
        if let g = groups("^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$") {
            return validDate(Int(g[2])!, Int(g[0])!, Int(g[1])!) || validDate(Int(g[2])!, Int(g[1])!, Int(g[0])!) ? range : nil
        }
        if let g = groups("^([0-9]{1,2})\\.? (\(month))\\.? ([0-9]{4})$") { return validDate(Int(g[2])!, months[g[1]]!, Int(g[0])!) ? range : nil }
        if let g = groups("^(\(month))\\.? ([0-9]{1,2}),? ([0-9]{4})$") { return validDate(Int(g[2])!, months[g[0]]!, Int(g[1])!) ? range : nil }
        return nil
    }

    private static let acceptUrl: Accept = { text, range in
        guard !isWord(text, range.lowerBound - 1) else { return nil }
        var stop = range.upperBound
        while stop > range.lowerBound, ".,;:)".contains(char(text, stop - 1) ?? "") { stop -= 1 }
        return stop - range.lowerBound >= 8 ? range.lowerBound..<stop : nil
    }

    private static let acceptIp: Accept = { text, range in
        let s = sub(text, range)
        if s.contains(":") {
            if isWord(text, range.lowerBound - 1) || char(text, range.lowerBound - 1) == ":"
                || isWord(text, range.upperBound) || char(text, range.upperBound) == ":" { return nil }
            let groups = s.split(separator: ":", omittingEmptySubsequences: true)
            return groups.count <= 8 && (s.contains("::") || groups.count == 8) ? range : nil
        }
        if isWord(text, range.lowerBound - 1) || char(text, range.lowerBound - 1) == "."
            || isWord(text, range.upperBound) || continuesAfter(text, range.upperBound) { return nil }
        return s.split(separator: ".").allSatisfy { Int($0)! <= 255 } ? range : nil
    }
}
