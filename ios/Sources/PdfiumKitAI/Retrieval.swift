import Foundation

enum Retrieval {
    /// Lower-cased letter and digit runs. Diacritics are kept: "Straße" is not "Strasse".
    static func tokens(_ text: String) -> [String] {
        let lowered = text.lowercased()
        let pattern = try! NSRegularExpression(pattern: "[\\p{L}\\p{N}]+")
        let units = NSString(string: lowered)
        return pattern.matches(in: lowered, range: NSRange(location: 0, length: units.length))
            .map { units.substring(with: $0.range) }
    }

    /// Ranks passages against a question with BM25, on the device and without a model
    /// (ANS-1). Returns only passages sharing a term with the question, best first, and
    /// stops before their combined text would exceed `budget` UTF-16 units.
    static func retrieve(_ passages: [PdfPassage], question: String, budget: Int) -> [PdfPassage] {
        let k1 = 1.2, b = 0.75
        var seen = Set<String>()
        let terms = tokens(question).filter { seen.insert($0).inserted }
        guard !terms.isEmpty, !passages.isEmpty else { return [] }

        let docs = passages.map { tokens($0.text) }
        let averageLength = max(1, Double(docs.reduce(0) { $0 + $1.count }) / Double(docs.count))
        var documentFrequency: [String: Int] = [:]
        for doc in docs { for term in Set(doc) { documentFrequency[term, default: 0] += 1 } }

        let scored = zip(passages, docs).map { passage, doc -> (PdfPassage, Double) in
            var score = 0.0
            for term in terms {
                let frequency = Double(doc.filter { $0 == term }.count)
                guard frequency > 0 else { continue }
                let n = Double(documentFrequency[term] ?? 0)
                let idf = log(1 + (Double(passages.count) - n + 0.5) / (n + 0.5))
                score += idf * (frequency * (k1 + 1))
                    / (frequency + k1 * (1 - b + b * Double(doc.count) / averageLength))
            }
            return (passage, score)
        }

        var picked: [PdfPassage] = []
        var used = 0
        // Stable on ties, so equal scores keep document order as they do on the web.
        for (passage, _) in scored.enumerated().filter({ $0.element.1 > 0 })
            .sorted(by: { $0.element.1 != $1.element.1 ? $0.element.1 > $1.element.1 : $0.offset < $1.offset })
            .map(\.element) {
            let length = passage.text.utf16.count
            if used + length > budget { break }
            picked.append(passage)
            used += length
        }
        return picked
    }
}
