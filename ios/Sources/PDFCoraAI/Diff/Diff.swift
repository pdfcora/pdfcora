import Foundation
import PDFCora

public let diffNotice = "Check the differences against both documents."

public struct PdfDiffSide: Sendable, Equatable {
    public let pageIndex: Int
    /// UTF-16 offsets in the page text.
    public let range: Range<Int>
    public let text: String
    public let rects: [PdfRect]
}

public struct PdfDiffChange: Sendable, Equatable {
    public enum Kind: String, Sendable { case modified, added, removed }
    public enum Label: String, Sendable { case meaningChanged, wordingOnly, unclassified }

    /// `"c<n>"`, in order.
    public let id: String
    public let kind: Kind
    public let label: Label
    public let summary: String?
    /// Absent for added sentences.
    public let original: PdfDiffSide?
    /// Absent for removed sentences.
    public let revised: PdfDiffSide?
    public let source: PdfAiSource
}

public struct PdfDiff: Sendable {
    public let changes: [PdfDiffChange]
    public let modelUsed: Bool
    /// Must be shown with the changes.
    public let notice: String
}

/// Spec: docs/superpowers/specs/2026-09-15-semantic-diff-design.md, function for function with the web.
enum DiffAligner {
    enum Alignment: Equatable { case modified(Int, Int), removed(Int), added(Int) }

    static let threshold = 0.3

    static func normalise(_ text: String) -> String {
        let folded = text.lowercased()
            .replacingOccurrences(of: "[‘’]", with: "'", options: .regularExpression)
            .replacingOccurrences(of: "[“”]", with: "\"", options: .regularExpression)
            .replacingOccurrences(of: "[–—]", with: "-", options: .regularExpression)
        return folded.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func similarity(_ a: String, _ b: String) -> Double {
        func grams(_ text: String) -> Set<String> {
            let scalars = Array(normalise(text).unicodeScalars)
            guard scalars.count >= 3 else { return [] }
            return Set((0...(scalars.count - 3)).map { i in String(String.UnicodeScalarView(scalars[i..<(i + 3)])) })
        }
        let x = grams(a), y = grams(b)
        guard x.count + y.count > 0 else { return 0 }
        return 2 * Double(x.intersection(y).count) / Double(x.count + y.count)
    }

    static func align(_ original: [String], _ revised: [String]) -> [Alignment] {
        let a = original.map(normalise), b = revised.map(normalise)
        var lcs = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                lcs[i][j] = a[i] == b[j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
            }
        }
        var anchors: [(Int, Int)] = []
        var i = 0, j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] { anchors.append((i, j)); i += 1; j += 1 }
            else if lcs[i + 1][j] >= lcs[i][j + 1] { i += 1 }
            else { j += 1 }
        }
        anchors.append((a.count, b.count))

        var result: [Alignment] = []
        i = 0; j = 0
        for (ai, bj) in anchors {
            let gapA = Array(i..<ai), gapB = Array(j..<bj)
            func text(_ list: [String], _ gap: [Int], _ k: Int) -> String { k < gap.count ? list[gap[k]] : "" }
            var x = 0, y = 0
            while x < gapA.count && y < gapB.count {
                if similarity(text(original, gapA, x), text(revised, gapB, y)) >= threshold {
                    result.append(.modified(gapA[x], gapB[y])); x += 1; y += 1
                } else if similarity(text(revised, gapB, y), text(original, gapA, x + 1))
                            >= similarity(text(original, gapA, x), text(revised, gapB, y + 1)) {
                    result.append(.removed(gapA[x])); x += 1
                } else {
                    result.append(.added(gapB[y])); y += 1
                }
            }
            for k in x..<gapA.count { result.append(.removed(gapA[k])) }
            for k in y..<gapB.count { result.append(.added(gapB[k])) }
            i = ai + 1; j = bj + 1
        }
        return result
    }

    static let schema = """
    {"type":"object","properties":{"label":{"type":"string","enum":["meaningChanged","wordingOnly"]},"summary":{"type":"string"}},"required":["label","summary"]}
    """

    static func prompt(_ original: String, _ revised: String) -> String {
        func quote(_ s: String) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: [s]), encoding: .utf8)!.dropFirst().dropLast().description
        }
        return [
            "Two versions of a sentence from a document follow.",
            "Decide whether the revision changes the meaning — what is required, allowed or promised, or any number, date, name or amount — or only the wording.",
            "Reply with JSON: {\"label\": \"meaningChanged\" or \"wordingOnly\", \"summary\": \"...\"}.",
            "For meaningChanged, the summary is one sentence describing the change in meaning, in the language of the sentences; for wordingOnly it is empty.",
            "Original: \(quote(original))",
            "Revised: \(quote(revised))",
        ].joined(separator: "\n")
    }

    struct Answer: Sendable { let label: PdfDiffChange.Label; let summary: String }

    static func parse(_ text: String) -> Answer? {
        guard let from = text.firstIndex(of: "{"), let to = text.lastIndex(of: "}"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[from...to].utf8)) as? [String: Any],
              let raw = object["label"] as? String, raw == "meaningChanged" || raw == "wordingOnly",
              let label = PdfDiffChange.Label(rawValue: raw) else { return nil }
        return Answer(label: label, summary: ((object["summary"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    struct Sentence { let pageIndex: Int; let range: Range<Int>; let text: String }

    static func sentences(_ document: PdfDocument, _ pages: ClosedRange<Int>?) async throws -> [Sentence] {
        let (texts, _) = try await TextLayer.readPages(document, range: pages)
        return texts.flatMap { page in
            let units = NSString(string: page.text)
            return TextLayer.sentences(of: page.text).map {
                Sentence(pageIndex: page.pageIndex, range: $0, text: units.substring(with: NSRange(location: $0.lowerBound, length: $0.count)))
            }
        }
    }
}

extension PdfAI {
    public struct Diff: Sendable {
        let ai: PdfAI

        /// Compares this document (the original) with a revised version: sentences aligned without
        /// a model, and each reworded pair labelled as a change in meaning or wording by Apple's
        /// on-device model or the custom provider.
        public func compare(revised: PdfDocument, pages: ClosedRange<Int>? = nil,
                            revisedPages: ClosedRange<Int>? = nil) async throws -> PdfDiff {
            let document = ai.document
            let before = try await DiffAligner.sentences(document, pages)
            let after = try await DiffAligner.sentences(revised, revisedPages)
            func side(_ doc: PdfDocument, _ s: DiffAligner.Sentence) async throws -> PdfDiffSide {
                PdfDiffSide(pageIndex: s.pageIndex, range: s.range, text: s.text,
                            rects: try await TextLayer.rects(doc, pageIndex: s.pageIndex, range: s.range))
            }
            let apple = ai.appleReading()
            let useApple = apple?.isPromptable == true
            let provider = ai.options.provider

            var modelUsed = false
            var changes: [PdfDiffChange] = []
            for item in DiffAligner.align(before.map(\.text), after.map(\.text)) {
                let id = "c\(changes.count + 1)"
                switch item {
                case .removed(let i):
                    changes.append(PdfDiffChange(id: id, kind: .removed, label: .meaningChanged, summary: nil,
                                                 original: try await side(document, before[i]), revised: nil, source: .rules))
                case .added(let j):
                    changes.append(PdfDiffChange(id: id, kind: .added, label: .meaningChanged, summary: nil,
                                                 original: nil, revised: try await side(revised, after[j]), source: .rules))
                case .modified(let i, let j):
                    let original = try await side(document, before[i])
                    let changed = try await side(revised, after[j])
                    let prompt = DiffAligner.prompt(original.text, changed.text)
                    var outcome: PdfAiOutcome<DiffAligner.Answer>?
                    if useApple || provider != nil {
                        var onDevice: PdfAiRoute<DiffAligner.Answer>?
                        if useApple {
                            onDevice = {
                                guard let reply = try await AppleModel.respond(to: prompt) else { return nil }
                                return DiffAligner.parse(reply)
                            }
                        }
                        var custom: PdfAiRoute<DiffAligner.Answer>?
                        if let provider {
                            custom = {
                                let response = try await provider.generate(PdfAiRequest(prompt: prompt, schema: DiffAligner.schema))
                                return DiffAligner.parse(response.structured ?? response.text)
                            }
                        }
                        outcome = await resolveRoutes(onDevice: onDevice, customProvider: custom)
                    }
                    if case .answered(let result)? = outcome {
                        modelUsed = true
                        let summary = result.value.label == .meaningChanged && !result.value.summary.isEmpty ? Trial.text(result.value.summary) : nil
                        changes.append(PdfDiffChange(id: id, kind: .modified, label: result.value.label, summary: summary,
                                                     original: original, revised: changed, source: result.source))
                    } else {
                        changes.append(PdfDiffChange(id: id, kind: .modified, label: .unclassified, summary: nil,
                                                     original: original, revised: changed, source: .rules))
                    }
                }
            }
            return PdfDiff(changes: changes, modelUsed: modelUsed, notice: Trial.text(diffNotice))
        }
    }

    public var diff: Diff { Diff(ai: self) }
}
