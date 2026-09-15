import Foundation
import UIKit
import PdfiumKit

public let altTextNotice = "Check every description before it is written."

public struct PdfAltTextProposal: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case description, decorative }

    /// `"<pageIndex>:<marked-content ids joined by ,>"`.
    public let id: String
    public let pageIndex: Int
    public let markedContentIds: [Int]
    public let rect: PdfRect
    public let kind: Kind
    /// Empty when no route proposed a description; a person writes one.
    public let text: String
    public let source: PdfAiSource?
    /// The page text given to the model as context.
    public let context: String
}

/// A person's decision on one proposal: `text` replaces the proposed description.
public struct PdfAltTextDecision: Sendable, Equatable {
    public let id: String
    public let text: String?
    public let decorative: Bool?

    public init(id: String, text: String? = nil, decorative: Bool? = nil) {
        self.id = id
        self.text = text
        self.decorative = decorative
    }
}

public struct PdfAltTextReview: Sendable {
    /// True when the document is not tagged: nothing is listed, it needs tags first.
    public let untagged: Bool
    public let items: [PdfAltTextProposal]
    public let modelUsed: Bool
    /// Must be shown with the proposals (HIL).
    public let notice: String
    let document: PdfDocument

    /// Writes the decisions, returning a new document; this document is unchanged.
    public func apply(_ decisions: [PdfAltTextDecision]) async throws -> PdfDocument {
        let byId = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        let edits = try decisions.map { decision -> PdfFigureEdit in
            guard let item = byId[decision.id] else { throw PdfProposalError.unknownProposal(decision.id) }
            let decorative = decision.decorative ?? (item.kind == .decorative)
            let text = (decision.text ?? item.text).trimmingCharacters(in: .whitespacesAndNewlines)
            if decorative { return PdfFigureEdit(pageIndex: item.pageIndex, markedContentIds: item.markedContentIds, change: .decorative) }
            guard !text.isEmpty else { throw PdfProposalError.missingDescription(decision.id) }
            return PdfFigureEdit(pageIndex: item.pageIndex, markedContentIds: item.markedContentIds, change: .altText(text))
        }
        return try await document.updateFigures(edits)
    }
}

enum AltTextProposer {
    static let contextMargin = 48.0
    static let contextChars = 500
    static let imagePixels = 512.0
    static let maxScale = 4.0

    static let schema = """
    {"type":"object","properties":{"decorative":{"type":"boolean"},"description":{"type":"string"}},"required":["decorative","description"]}
    """

    static func prompt(_ context: String) -> String {
        let quoted = String(data: try! JSONSerialization.data(withJSONObject: [context]), encoding: .utf8)!.dropFirst().dropLast()
        return [
            "Write alternative text for the attached image from a PDF, for a reader who cannot see it.",
            "One sentence of at most 150 characters saying what the image shows and why it matters here.",
            "Do not begin with \"Image of\" or \"Picture of\".",
            "If the image is only decoration and adds no information, answer decorative true with an empty description.",
            "Text near the image on the page: \(quoted)",
        ].joined(separator: "\n")
    }

    /// Spec §2: too thin or too small to carry information.
    static func looksDecorative(_ rect: PdfRect) -> Bool {
        let width = rect.right - rect.left, height = rect.top - rect.bottom
        return min(width, height) <= 3 || width * height <= 100
    }

    struct Answer: Sendable { let decorative: Bool; let description: String }

    static func parse(_ text: String) -> Answer? {
        guard let from = text.firstIndex(of: "{"), let to = text.lastIndex(of: "}"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[from...to].utf8)) as? [String: Any] else { return nil }
        if object["decorative"] as? Bool == true { return Answer(decorative: true, description: "") }
        guard let description = (object["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !description.isEmpty else { return nil }
        return Answer(decorative: false, description: description)
    }

    static func figuresMissingAlt(_ elements: [PdfStructureElement]) -> [PdfStructureElement] {
        func blank(_ s: String?) -> Bool { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        return elements.flatMap { e in
            (e.type == "Figure" && blank(e.altText) && blank(e.actualText) && e.bounds != nil && !e.markedContentIds.isEmpty ? [e] : [])
                + figuresMissingAlt(e.children)
        }
    }

    /// Spec §5.2: characters whose centre lies within 48 pt above or below the figure, across the page.
    static func context(_ rect: PdfRect, _ characters: [(Character, PdfRect?)]) -> String {
        let text = String(characters.map { char, box -> Character in
            guard let box else { return " " }
            let y = (box.bottom + box.top) / 2
            return y >= rect.bottom - contextMargin && y <= rect.top + contextMargin ? char : " "
        })
        let collapsed = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return String(collapsed.prefix(contextChars))
    }

    static func characters(_ page: PdfPage) async throws -> [(Character, PdfRect?)] {
        let units = Array(try await page.text.string().utf16)
        var out: [(Character, PdfRect?)] = []
        for (i, unit) in units.enumerated() {
            let box = try await page.text.boundingBox(ofCharacterAt: i)
            let char = UnicodeScalar(unit).map(Character.init) ?? " "
            out.append((char, box.right > box.left && box.top > box.bottom ? box : nil))
        }
        return out
    }

    static func image(_ page: PdfPage, _ rect: PdfRect) async throws -> Data {
        let size = try await page.size
        let scale = min(maxScale, imagePixels / max(rect.right - rect.left, rect.top - rect.bottom))
        let rendered = try await page.render(pixelWidth: max(1, Int((size.width * scale).rounded())),
                                             pixelHeight: max(1, Int((size.height * scale).rounded())))
        guard let full = rendered.cgImage else { throw PdfError.engine(code: -1) }
        let x0 = max(0, (rect.left * scale).rounded(.down))
        let y0 = max(0, ((size.height - rect.top) * scale).rounded(.down))
        let x1 = min(Double(full.width), (rect.right * scale).rounded(.up))
        let y1 = min(Double(full.height), ((size.height - rect.bottom) * scale).rounded(.up))
        let crop = CGRect(x: x0, y: y0, width: max(1, x1 - x0), height: max(1, y1 - y0))
        guard let cropped = full.cropping(to: crop), let png = UIImage(cgImage: cropped).pngData() else {
            throw PdfError.engine(code: -1)
        }
        return png
    }
}

extension PdfiumAI {
    public struct AltText: Sendable {
        let ai: PdfiumAI

        /// Lists figures in a tagged document that have no alternate text and proposes a
        /// description, or decorative marking, for each (ALT). Descriptions need the custom
        /// provider: Apple's on-device model takes no images. Nothing is written until `apply`,
        /// which returns a new document.
        public func suggest(pages: ClosedRange<Int>? = nil) async throws -> PdfAltTextReview {
            let document = ai.document
            let untagged = !(try await document.isTagged)
            var items: [PdfAltTextProposal] = []
            var modelUsed = false

            let count = await document.pageCount
            let range = max(0, pages?.lowerBound ?? 0)...min(count - 1, pages?.upperBound ?? count - 1)
            for pageIndex in untagged || count == 0 ? [] : Array(range) {
                let page = try await document.page(pageIndex)
                let figures = AltTextProposer.figuresMissingAlt(try await page.structure())
                    .sorted { a, b in a.bounds!.top != b.bounds!.top ? a.bounds!.top > b.bounds!.top : a.bounds!.left < b.bounds!.left }
                guard !figures.isEmpty else { continue }
                let characters = try await AltTextProposer.characters(page)

                for figure in figures {
                    let rect = figure.bounds!
                    let id = "\(pageIndex):\(figure.markedContentIds.map(String.init).joined(separator: ","))"
                    let context = AltTextProposer.context(rect, characters)
                    func item(_ kind: PdfAltTextProposal.Kind, _ text: String, _ source: PdfAiSource?) -> PdfAltTextProposal {
                        PdfAltTextProposal(id: id, pageIndex: pageIndex, markedContentIds: figure.markedContentIds,
                                           rect: rect, kind: kind, text: text, source: source, context: context)
                    }
                    if AltTextProposer.looksDecorative(rect) {
                        items.append(item(.decorative, "", .rules))
                        continue
                    }
                    guard let provider = ai.options.provider else {
                        items.append(item(.description, "", nil))
                        continue
                    }
                    let outcome: PdfAiOutcome<AltTextProposer.Answer> = await resolveRoutes(customProvider: {
                        let png = try await AltTextProposer.image(page, rect)
                        let response = try await provider.generate(
                            PdfAiRequest(prompt: AltTextProposer.prompt(context), images: [png], schema: AltTextProposer.schema))
                        return AltTextProposer.parse(response.structured ?? response.text)
                    })
                    if case .answered(let result) = outcome {
                        modelUsed = true
                        items.append(result.value.decorative
                            ? item(.decorative, "", result.source)
                            : item(.description, Trial.text(result.value.description), result.source))
                    } else {
                        items.append(item(.description, "", nil))
                    }
                }
            }
            return PdfAltTextReview(untagged: untagged, items: items, modelUsed: modelUsed,
                                    notice: Trial.text(altTextNotice), document: document)
        }
    }

    public var altText: AltText { AltText(ai: self) }
}
