import Foundation
import PdfiumKit

public let remediationNotice = "Check every tag and the reading order before they are written."

public struct PdfRemediationBlock: Sendable, Equatable {
    /// `"<pageIndex>:<first object index>"`.
    public let id: String
    /// 1-based, across the document.
    public let order: Int
    public let pageIndex: Int
    public let type: PdfTagType
    public let objectIndices: [Int]
    public let rect: PdfRect
    /// For review; empty for figures and artifacts.
    public let text: String
}

public struct PdfRemediationReview: Sendable {
    /// True when the document is tagged already: nothing is proposed.
    public let alreadyTagged: Bool
    public let blocks: [PdfRemediationBlock]
    /// Must be shown with the proposals (HIL).
    public let notice: String
    let document: PdfDocument

    /// Tags the document as proposed, with type overrides by block id, returning a new document.
    /// `title` defaults to the first H1's text, else the first heading's.
    public func apply(types: [String: PdfTagType] = [:], language: String? = nil, title: String? = nil) async throws -> PdfDocument {
        let known = Set(blocks.map(\.id))
        if let unknown = types.keys.first(where: { !known.contains($0) }) { throw PdfProposalError.unknownProposal(unknown) }
        let typed = blocks.map { ($0, types[$0.id] ?? $0.type) }
        let headings = typed.filter { [.h1, .h2, .h3, .h4, .h5, .h6].contains($0.1) }
        let title = title ?? (headings.first { $0.1 == .h1 } ?? headings.first)?.0.text
        return try await document.tagContent(
            typed.map { PdfTagBlock(pageIndex: $0.0.pageIndex, type: $0.1, objectIndices: $0.0.objectIndices) },
            title: title, language: language)
    }
}

/// Spec §4.2 of `2026-09-15-remediation-design.md`, function for function with the web.
enum RemediationRules {
    static let headingRatio = 1.2
    static let headingChars = 200

    final class Draft {
        let pageIndex: Int
        var type: PdfTagType
        var objects: [PdfPageObject]
        var rect: PdfRect
        let size: Double
        var text: String
        init(pageIndex: Int, type: PdfTagType, objects: [PdfPageObject], rect: PdfRect, size: Double, text: String) {
            self.pageIndex = pageIndex; self.type = type; self.objects = objects; self.rect = rect; self.size = size; self.text = text
        }
    }

    static func startsWithListMarker(_ text: String) -> Bool {
        text.range(of: #"^(?:[•◦▪‣\-–*]\s|(?:\d{1,3}|[A-Za-z])[.)]\s)"#, options: .regularExpression) != nil
    }

    static func union(_ a: PdfRect, _ b: PdfRect) -> PdfRect {
        PdfRect(left: min(a.left, b.left), bottom: min(a.bottom, b.bottom), right: max(a.right, b.right), top: max(a.top, b.top))
    }

    static func pageBlocks(_ pageIndex: Int, _ objects: [PdfPageObject]) -> [Draft] {
        var blocks: [Draft] = []
        var line: (objects: [PdfPageObject], rect: PdfRect, size: Double, text: String)?
        var block: Draft?

        func closeLine() {
            guard let current = line else { return }
            line = nil
            if let b = block, blocks.last === b,
               abs(b.size - current.size) <= 0.5,
               b.rect.bottom - current.rect.top <= current.size / 2,
               abs(b.rect.left - current.rect.left) <= current.size,
               !startsWithListMarker(current.text) {
                b.objects += current.objects
                b.rect = union(b.rect, current.rect)
                b.text += " " + current.text
            } else {
                let b = Draft(pageIndex: pageIndex, type: .p, objects: current.objects, rect: current.rect, size: current.size, text: current.text)
                blocks.append(b)
                block = b
            }
        }

        for object in objects {
            let text = (object.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if object.kind == .text && text.isEmpty { continue }
            guard object.kind == .text else {
                closeLine()
                block = nil
                let figure = (object.kind == .image || object.kind == .form) && !AltTextProposer.looksDecorative(object.bounds)
                blocks.append(Draft(pageIndex: pageIndex, type: figure ? .figure : .artifact, objects: [object], rect: object.bounds, size: 0, text: ""))
                continue
            }
            let size = object.fontSize ?? 0
            let b = object.bounds
            if let l = line, abs(l.size - size) <= 0.5,
               min(l.rect.top, b.top) - max(l.rect.bottom, b.bottom) >= min(l.rect.top - l.rect.bottom, b.top - b.bottom) / 2,
               b.left >= l.rect.right - size {
                line = (l.objects + [object], union(l.rect, b), l.size, l.text + " " + text)
            } else {
                closeLine()
                line = ([object], b, size, text)
            }
        }
        closeLine()
        return blocks
    }

    static func typeBlocks(_ drafts: [Draft]) {
        func rounded(_ size: Double) -> Double { (size * 2).rounded() / 2 }
        var characters: [Double: Int] = [:]
        for d in drafts where d.type == .p {
            for o in d.objects { characters[rounded(o.fontSize ?? 0), default: 0] += (o.text ?? "").utf16.count }
        }
        let body = characters.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.first?.key ?? 0
        func isHeading(_ d: Draft) -> Bool { body > 0 && d.size >= body * headingRatio && d.text.utf16.count <= headingChars }

        let headingSizes = Array(Set(drafts.filter { $0.type == .p && !startsWithListMarker($0.text) && isHeading($0) }.map { rounded($0.size) }))
            .sorted(by: >)
        let levels: [PdfTagType] = [.h1, .h2, .h3, .h4, .h5, .h6]
        for d in drafts where d.type == .p {
            if startsWithListMarker(d.text) { d.type = .li }
            else if isHeading(d), let rank = headingSizes.firstIndex(of: rounded(d.size)) { d.type = levels[min(5, rank)] }
        }
    }
}

extension PdfiumAI {
    public struct Remediation: Sendable {
        let ai: PdfiumAI

        /// Proposes tags and a reading order for an untagged document (REM), by rules on the page
        /// objects, identically on every platform. Nothing is written until `apply`, which returns
        /// a new document; describe its figures with `altText` afterwards.
        public func suggest(pages: ClosedRange<Int>? = nil) async throws -> PdfRemediationReview {
            let document = ai.document
            let alreadyTagged = try await document.isTagged
            let count = await document.pageCount
            var drafts: [RemediationRules.Draft] = []
            if !alreadyTagged, count > 0 {
                for pageIndex in max(0, pages?.lowerBound ?? 0)...min(count - 1, pages?.upperBound ?? count - 1) {
                    drafts += RemediationRules.pageBlocks(pageIndex, try await document.pageObjects(at: pageIndex))
                }
            }
            RemediationRules.typeBlocks(drafts)
            let blocks = drafts.enumerated().map { i, d in
                PdfRemediationBlock(id: "\(d.pageIndex):\(d.objects[0].index)", order: i + 1, pageIndex: d.pageIndex,
                                    type: d.type, objectIndices: d.objects.map(\.index), rect: d.rect, text: d.text)
            }
            return PdfRemediationReview(alreadyTagged: alreadyTagged, blocks: blocks, notice: Trial.text(remediationNotice), document: document)
        }
    }

    public var remediation: Remediation { Remediation(ai: self) }
}
