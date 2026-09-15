import Foundation
import PdfiumKit

public let formNotice = "Check every value before filling in the form."

public enum PdfFormValue: Sendable, Equatable {
    case text(String)
    case option(Int)
    case checked
}

public struct PdfFormProposal: Sendable, Equatable {
    public let id: String
    public let pageIndex: Int
    public let annotationIndex: Int
    public let fieldName: String?
    public let key: PdfProfileKey
    public let value: PdfFormValue
    public let source: PdfAiSource
    public let rect: PdfRect
}

public struct PdfFormApplied: Sendable {
    let snapshot: PdfDocumentSnapshot
    /// Reopens the document as it was before `apply`.
    public func undo() async throws -> PdfDocument { try await snapshot.open() }
}

public struct PdfFormProposals: Sendable {
    public let items: [PdfFormProposal]
    public let modelUsed: Bool
    /// Must be shown with the proposals (HIL).
    public let notice: String
    let document: PdfDocument

    public func apply(accepting acceptedIds: [String]) async throws -> PdfFormApplied {
        let known = Set(items.map(\.id))
        if let unknown = acceptedIds.first(where: { !known.contains($0) }) { throw PdfProposalError.unknownProposal(unknown) }
        let snapshot = try await document.snapshot()
        for proposal in items where acceptedIds.contains(proposal.id) {
            let page = try await document.page(proposal.pageIndex)
            switch proposal.value {
            case .text(let text): try await page.setText(text, forFieldAt: proposal.annotationIndex)
            case .option(let index): try await page.setOption(index, selected: true, forFieldAt: proposal.annotationIndex)
            case .checked: try await page.setChecked(true, forFieldAt: proposal.annotationIndex)
            }
        }
        return PdfFormApplied(snapshot: snapshot)
    }
}

enum FormProposer {
    static let schema = """
    {"type":"object","properties":{"fields":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"key":{"type":"string","enum":["givenName","familyName","fullName","dateOfBirth","email","phone","street","postalCode","city","country","iban","company","unknown"]}},"required":["id","key"]}}},"required":["fields"]}
    """

    static func prompt(_ fields: [PdfFieldDescription]) -> String {
        func quote(_ s: String?) -> String {
            String(data: try! JSONSerialization.data(withJSONObject: [s ?? ""]), encoding: .utf8)!.dropFirst().dropLast().description
        }
        let keys = PdfProfileKey.allCases.map(\.rawValue).joined(separator: ", ")
        return ([
            "Match each form field below to one of these profile keys, or \"unknown\": \(keys).",
            "Reply with JSON: {\"fields\": [{\"id\": \"...\", \"key\": \"...\"}]}.",
            "Fields:",
        ] + fields.map { f in
            var options = ""
            switch f.field {
            case .comboBox(let c), .listBox(let c):
                options = ", options " + String(data: try! JSONSerialization.data(withJSONObject: c.options), encoding: .utf8)!
            default: break
            }
            return "- id \(f.pageIndex):\(f.base.annotationIndex): name \(quote(f.base.name)), tooltip \(quote(f.base.alternateName)), label \(quote(f.label)), kind \(kindName(f.field))\(options)"
        }).joined(separator: "\n")
    }

    static func kindName(_ field: PdfFormField) -> String {
        switch field {
        case .text: "text"
        case .checkBox: "checkBox"
        case .radioButton: "radioButton"
        case .comboBox: "comboBox"
        case .listBox: "listBox"
        case .pushButton: "pushButton"
        case .signature: "signature"
        case .unknown: "unknown"
        }
    }

    static func isFillable(_ field: PdfFormField) -> Bool {
        switch field {
        case .text, .checkBox, .radioButton, .comboBox, .listBox: !field.base.isReadOnly
        default: false
        }
    }

    /// The value to propose, or nil when the profile value does not fit the field (FORM-5).
    static func value(for f: PdfFieldDescription, key: PdfProfileKey, raw: String) -> PdfFormValue? {
        switch f.field {
        case .text(let text):
            var value = raw
            if key == .dateOfBirth, let m = raw.firstMatch(#"^(\d{4})-(\d{2})-(\d{2})$"#) {
                let hint = (Synonyms.formatHint(f.base.alternateName ?? "") ?? Synonyms.formatHint(f.label ?? "")
                    ?? Synonyms.formatHint(f.base.name ?? "") ?? "").uppercased().replacingOccurrences(of: " ", with: "")
                let (y, mo, d) = (m[0], m[1], m[2])
                switch hint {
                case "TT.MM.JJJJ", "DD.MM.YYYY": value = "\(d).\(mo).\(y)"
                case "MM/DD/YYYY": value = "\(mo)/\(d)/\(y)"
                case "DD/MM/YYYY": value = "\(d)/\(mo)/\(y)"
                default: break
                }
            }
            return value == text.value ? nil : .text(value)
        case .comboBox(let choice), .listBox(let choice):
            guard let index = choice.options.firstIndex(where: {
                Synonyms.normalise($0) == Synonyms.normalise(raw) && !Synonyms.normalise($0).isEmpty
            }), !choice.selectedIndices.contains(index) else { return nil }
            return .option(index)
        case .checkBox(let toggle), .radioButton(let toggle):
            guard let export = toggle.exportValue, Synonyms.normalise(export) == Synonyms.normalise(raw), !toggle.isChecked else { return nil }
            return .checked
        default:
            return nil
        }
    }

    struct FieldMatch: Sendable { let id: String; let key: String }

    static func parse(_ text: String) -> [FieldMatch] {
        guard let from = text.firstIndex(of: "{"), let to = text.lastIndex(of: "}"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[from...to].utf8)) as? [String: Any],
              let fields = object["fields"] as? [[String: Any]] else { return [] }
        return fields.compactMap { f in
            guard let id = f["id"] as? String, let key = f["key"] as? String else { return nil }
            return FieldMatch(id: id, key: key)
        }
    }
}

private extension String {
    func firstMatch(_ pattern: String) -> [String]? {
        guard let m = try! NSRegularExpression(pattern: pattern).firstMatch(in: self, range: NSRange(startIndex..., in: self)) else { return nil }
        return (1..<m.numberOfRanges).map { (self as NSString).substring(with: m.range(at: $0)) }
    }
}

extension PdfiumAI {
    public struct Forms: Sendable {
        let ai: PdfiumAI

        /// Proposes values for the document's form fields from a profile the host passes in
        /// (FORM). The synonym list runs on every device; Apple's on-device model, or the custom
        /// provider, matches fields it cannot. The profile is not stored. Nothing is written
        /// until `apply`.
        public func propose(profile: [PdfProfileKey: String], pages: ClosedRange<Int>? = nil) async throws -> PdfFormProposals {
            let document = ai.document
            let fields = try await FieldDescriber.describe(document, pages: pages).filter { FormProposer.isFillable($0.field) }

            var matched: [String: (key: PdfProfileKey, source: PdfAiSource)] = [:]
            func id(_ f: PdfFieldDescription) -> String { "\(f.pageIndex):\(f.base.annotationIndex)" }
            for f in fields {
                if let key = Synonyms.key(name: f.base.name, alternateName: f.base.alternateName, label: f.label) {
                    matched[id(f)] = (key, .rules)
                }
            }

            var modelUsed = false
            let unknown = fields.filter { matched[id($0)] == nil }
            let apple = ai.appleReading()
            let provider = ai.options.provider
            if !unknown.isEmpty, apple?.isPromptable == true || provider != nil {
                let prompt = FormProposer.prompt(unknown)
                var onDevice: PdfAiRoute<[FormProposer.FieldMatch]>?
                if apple?.isPromptable == true {
                    onDevice = {
                        guard let reply = try await AppleModel.respond(to: prompt) else { return nil }
                        return FormProposer.parse(reply)
                    }
                }
                var customProvider: PdfAiRoute<[FormProposer.FieldMatch]>?
                if let provider {
                    customProvider = {
                        let response = try await provider.generate(PdfAiRequest(prompt: prompt, schema: FormProposer.schema))
                        return FormProposer.parse(response.structured ?? response.text)
                    }
                }
                let outcome = await resolveRoutes(onDevice: onDevice, customProvider: customProvider)
                if case .answered(let result) = outcome {
                    modelUsed = true
                    let sent = Set(unknown.map(id))
                    for match in result.value {
                        if sent.contains(match.id), matched[match.id] == nil, let key = PdfProfileKey(rawValue: match.key) {
                            matched[match.id] = (key, result.source)
                        }
                    }
                }
            }

            var items: [PdfFormProposal] = []
            for f in fields {
                guard let match = matched[id(f)], let raw = profile[match.key],
                      let value = FormProposer.value(for: f, key: match.key, raw: raw) else { continue }
                items.append(PdfFormProposal(id: "\(id(f)):\(match.key.rawValue)", pageIndex: f.pageIndex,
                    annotationIndex: f.base.annotationIndex, fieldName: f.base.name, key: match.key, value: value,
                    source: match.source, rect: f.base.rect))
            }
            return PdfFormProposals(items: items, modelUsed: modelUsed, notice: Trial.text(formNotice), document: document)
        }
    }

    /// Proposes form values from a profile (FORM).
    public var forms: Forms { Forms(ai: self) }
}
