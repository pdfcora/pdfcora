import Foundation
import PdfiumKit

public let detectNotice = "Check every field before it is added."

public struct PdfDetectedField: Sendable, Equatable {
    /// `"<pageIndex>:<n>"`, n counting on the page in order.
    public let id: String
    public let pageIndex: Int
    public let kind: PdfNewFormField.Kind
    public let rect: PdfRect
    /// Empty when no label was found.
    public let label: String
}

public struct PdfDetectedFields: Sendable {
    public let items: [PdfDetectedField]
    /// Must be shown with the proposals (HIL).
    public let notice: String
    let document: PdfDocument

    /// Creates the accepted fields, returning a new document; this document is unchanged.
    public func apply(accepting acceptedIds: [String]) async throws -> PdfDocument {
        let known = Set(items.map(\.id))
        if let unknown = acceptedIds.first(where: { !known.contains($0) }) { throw PdfProposalError.unknownProposal(unknown) }
        var existing = Set<String>()
        for pageIndex in 0..<(await document.pageCount) {
            for field in try await document.page(pageIndex).formFields() { if let name = field.base.name { existing.insert(name) } }
        }
        let fields = items.filter { acceptedIds.contains($0.id) }.enumerated().map { n, item -> PdfNewFormField in
            let base = item.label.isEmpty ? "Field \(n + 1)" : item.label
            var name = base
            var suffix = 2
            while existing.contains(name) { name = "\(base) \(suffix)"; suffix += 1 }
            existing.insert(name)
            return PdfNewFormField(pageIndex: item.pageIndex, kind: item.kind, rect: item.rect, name: name,
                                   tooltip: item.label.isEmpty ? nil : item.label)
        }
        return try await document.addFormFields(fields)
    }
}

/// Spec: docs/superpowers/specs/2026-09-15-flat-form-detection-design.md, function for function with the web.
enum FieldDetector {
    enum Rule { case underscores, line, box, square }
    struct Candidate { let rule: Rule; let kind: PdfNewFormField.Kind; let rect: PdfRect }

    static let fieldHeight = 14.0

    static func intersects(_ a: PdfRect, _ b: PdfRect) -> Bool {
        a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top
    }

    static func candidates(_ objects: [PdfPageObject], text: String, boxes: [PdfRect?], widgets: [PdfRect]) -> [Candidate] {
        let units = NSString(string: text)
        var found: [Candidate] = []
        let runs = try! NSRegularExpression(pattern: "_{5,}")
        for match in runs.matches(in: text, range: NSRange(location: 0, length: units.length)) {
            let rects = boxes[match.range.location..<(match.range.location + match.range.length)].compactMap { $0 }
            guard !rects.isEmpty else { continue }
            let bottom = rects.map(\.bottom).min()!
            found.append(Candidate(rule: .underscores, kind: .text, rect: PdfRect(
                left: rects.map(\.left).min()!, bottom: bottom, right: rects.map(\.right).max()!, top: bottom + fieldHeight)))
        }
        let paths = objects.filter { $0.kind == .path }.map(\.bounds)
        for b in paths where b.right - b.left >= 40 && b.top - b.bottom <= 2 {
            found.append(Candidate(rule: .line, kind: .text, rect: PdfRect(left: b.left, bottom: b.bottom, right: b.right, top: b.bottom + fieldHeight)))
        }
        for b in paths where b.right - b.left >= 40 && (10...40).contains(b.top - b.bottom) {
            found.append(Candidate(rule: .box, kind: .text, rect: b))
        }
        for b in paths {
            let w = b.right - b.left, h = b.top - b.bottom
            if (6...16).contains(w), (6...16).contains(h), abs(w - h) <= 2 { found.append(Candidate(rule: .square, kind: .checkBox, rect: b)) }
        }

        func occupied(_ r: PdfRect) -> Bool {
            boxes.indices.contains { i in
                guard let b = boxes[i] else { return false }
                let unit = units.character(at: i)
                if unit == 0x5F || (Unicode.Scalar(unit).map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? false) { return false }
                let x = (b.left + b.right) / 2, y = (b.bottom + b.top) / 2
                return x > r.left && x < r.right && y > r.bottom && y < r.top
            }
        }

        var kept: [Candidate] = []
        for candidate in found {
            if occupied(candidate.rect) || widgets.contains(where: { intersects($0, candidate.rect) }) { continue }
            if let clash = kept.firstIndex(where: { intersects($0.rect, candidate.rect) }) {
                let replaces = (candidate.rule == .box || candidate.rule == .square)
                    && (kept[clash].rule == .underscores || kept[clash].rule == .line)
                if replaces { kept[clash] = candidate }
            } else {
                kept.append(candidate)
            }
        }
        return kept
    }

    /// Spec §3 rule 8 for a checkbox: text on the same line to its right first.
    static func rightLabel(_ rect: PdfRect, others: [PdfRect], text: String, boxes: [PdfRect?]) -> String? {
        let bound = ([rect.right + 250] + others.filter { $0 != rect && $0.left >= rect.right && $0.bottom < rect.top && rect.bottom < $0.top }
            .map(\.left)).min()!
        let hits = boxes.indices.filter { i in
            guard let b = boxes[i] else { return false }
            let centre = (b.top + b.bottom) / 2
            return centre >= rect.bottom - 2 && centre <= rect.top + 2 && b.left >= rect.right - 1 && b.right <= bound
        }
        guard let first = hits.first, let last = hits.last else { return nil }
        let label = NSString(string: text).substring(with: NSRange(location: first, length: last - first + 1))
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"[:\s]+$"#, with: "", options: .regularExpression)
        return label.isEmpty ? nil : label
    }
}

extension PdfiumAI.Forms {
    /// Proposes form fields for the blanks of a flat PDF — lines, boxes, underscores (FORM-7), by
    /// rules on the page objects. Nothing is written until `apply`, which returns a new document.
    public func detect(pages: ClosedRange<Int>? = nil) async throws -> PdfDetectedFields {
        let document = ai.document
        let count = await document.pageCount
        var items: [PdfDetectedField] = []
        if count > 0 {
            for pageIndex in max(0, pages?.lowerBound ?? 0)...min(count - 1, pages?.upperBound ?? count - 1) {
                let page = try await document.page(pageIndex)
                let text = try await page.text.string()
                var boxes: [PdfRect?] = []
                for i in 0..<NSString(string: text).length {
                    let box = try await page.text.boundingBox(ofCharacterAt: i)
                    boxes.append(box.right > box.left && box.top > box.bottom ? box : nil)
                }
                let widgets = try await page.formFields().map(\.base.rect)
                let candidates = FieldDetector.candidates(try await document.pageObjects(at: pageIndex), text: text, boxes: boxes, widgets: widgets)
                    .sorted { $0.rect.top != $1.rect.top ? $0.rect.top > $1.rect.top : $0.rect.left < $1.rect.left }
                let rects = candidates.map(\.rect)
                for (n, c) in candidates.enumerated() {
                    let label = (c.kind == .checkBox ? FieldDetector.rightLabel(c.rect, others: rects, text: text, boxes: boxes) : nil)
                        ?? FieldDescriber.label(for: c.rect, others: rects, text: text, boxes: boxes) ?? ""
                    items.append(PdfDetectedField(id: "\(pageIndex):\(n)", pageIndex: pageIndex, kind: c.kind, rect: c.rect,
                                                  label: label.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")))
                }
            }
        }
        return PdfDetectedFields(items: items, notice: Trial.text(detectNotice), document: document)
    }
}
