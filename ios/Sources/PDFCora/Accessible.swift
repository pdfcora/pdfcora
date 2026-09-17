import Foundation
@_implementationOnly import CPdfium

/// One thing a screen reader announces on a page.
public struct PdfAccessibleNode: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable {
        case heading, paragraph, list, listItem, figure, table, row, headerCell, cell, formField
    }

    public let role: Role
    /// Headings only, 1–6.
    public let level: Int?
    /// The label to speak; empty for lists, tables and rows, and for a figure without alternate text.
    public let text: String
    public let bounds: PdfRect?
    public let children: [PdfAccessibleNode]
}

extension PdfPage {
    /// The page as a screen reader should hear it: headings, paragraphs, lists, figures by their
    /// alternate text, tables and form fields, in reading order. An untagged page is one paragraph.
    public func accessibleContent() async throws -> [PdfAccessibleNode] {
        let roots = try await structure()
        let (byId, all) = try await document.textByMarkedContentId(pageIndex: index)
        let size = try await self.size
        let fields = try await formFields()
        return AccessibleContent.nodes(roots, byId, all, PdfRect(left: 0, bottom: 0, right: size.width, top: size.height), fields)
    }
}

extension PdfDocument {
    /// The page's text split by marked-content id, through each character's text object. A
    /// generated character belongs to the character before it.
    func textByMarkedContentId(pageIndex: Int) throws -> ([Int: String], String) {
        let page = try loadedPage(pageIndex)
        guard let textPage = FPDFText_LoadPage(page) else { return ([:], "") }
        defer { FPDFText_ClosePage(textPage) }
        var byId: [Int: String] = [:]
        var all = ""
        var current = -1
        for i in 0..<max(0, Int(FPDFText_CountChars(textPage))) {
            let code = FPDFText_GetUnicode(textPage, Int32(i))
            let char = Character(UnicodeScalar(code == 0 ? 32 : code) ?? " ")
            all.append(char)
            if let object = FPDFText_GetTextObject(textPage, Int32(i)) { current = Int(FPDFPageObj_GetMarkedContentID(object)) }
            if current >= 0 { byId[current, default: ""].append(char) }
        }
        return (byId, all)
    }
}

/// Spec: docs/superpowers/specs/2026-09-15-accessible-content-design.md, function for function with the web.
enum AccessibleContent {
    static let paragraph: Set<String> = ["P", "Span", "Quote", "Code", "Link", "Note", "Reference", "BibEntry", "Caption",
                                         "TOCI", "Lbl", "LBody", "Index"]
    static let passThrough: Set<String> = ["THead", "TBody", "TFoot"]

    static func collapse(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func nodes(_ roots: [PdfStructureElement], _ byId: [Int: String], _ pageText: String,
                      _ pageBounds: PdfRect, _ fields: [PdfFormField]) -> [PdfAccessibleNode] {
        func own(_ e: PdfStructureElement) -> String { collapse(e.markedContentIds.map { byId[$0] ?? "" }.joined(separator: " ")) }
        func all(_ e: PdfStructureElement) -> String { collapse(([own(e)] + e.children.map(all)).joined(separator: " ")) }

        func map(_ e: PdfStructureElement) -> [PdfAccessibleNode] {
            func leaf(_ role: PdfAccessibleNode.Role, level: Int? = nil) -> [PdfAccessibleNode] {
                let text = e.actualText.map(collapse) ?? all(e)
                return text.isEmpty ? [] : [PdfAccessibleNode(role: role, level: level, text: text, bounds: e.bounds, children: [])]
            }
            func container(_ role: PdfAccessibleNode.Role) -> [PdfAccessibleNode] {
                let children = e.children.flatMap(map)
                return children.isEmpty ? [] : [PdfAccessibleNode(role: role, level: nil, text: "", bounds: e.bounds, children: children)]
            }
            let type = e.type
            if type == "H" { return leaf(.heading, level: 1) }
            if type.count == 2, type.hasPrefix("H"), let level = Int(type.dropFirst()), (1...6).contains(level) { return leaf(.heading, level: level) }
            if paragraph.contains(type) { return leaf(.paragraph) }
            switch type {
            case "LI": return leaf(.listItem)
            case "TH": return leaf(.headerCell)
            case "TD": return leaf(.cell)
            case "L", "TOC": return container(.list)
            case "Table": return container(.table)
            case "TR": return container(.row)
            case _ where passThrough.contains(type): return e.children.flatMap(map)
            case "Figure", "Formula":
                return [PdfAccessibleNode(role: .figure, level: nil, text: collapse(e.altText ?? e.actualText ?? all(e)), bounds: e.bounds, children: [])]
            default:
                let text = own(e)
                return (text.isEmpty ? [] : [PdfAccessibleNode(role: .paragraph, level: nil, text: text, bounds: e.bounds, children: [])])
                    + e.children.flatMap(map)
            }
        }

        var nodes = roots.isEmpty
            ? (collapse(pageText).isEmpty ? [] : [PdfAccessibleNode(role: .paragraph, level: nil, text: collapse(pageText), bounds: pageBounds, children: [])])
            : roots.flatMap(map)
        for field in fields {
            nodes.append(PdfAccessibleNode(role: .formField, level: nil, text: field.base.alternateName ?? field.base.name ?? "",
                                           bounds: field.base.rect, children: []))
        }
        return nodes
    }
}
