import Foundation

/// Writing figure alternate text into the structure tree.
///
/// PDFium reads structure elements but cannot change them, and its element handles carry
/// no object numbers. So the tree is walked again here, from the bytes, and a figure is
/// found by what both sides agree on: its page and its marked-content ids.
enum FigureWriter {
    struct Edit {
        let pageIndex: Int
        let markedContentIds: [Int]
        let altText: String?
        let decorative: Bool
    }

    struct Figure {
        let number: Int
        /// The indirect object whose /K lists this element.
        let parent: Int?
        let pageIndex: Int
        let ids: [Int]
    }

    struct NotFound: Error { let reason: String }

    private static let maxDepth = 64

    /// Every figure element that has marked content on a single page.
    static func figures(_ bytes: [UInt8]) throws -> [Figure] {
        let xref = try Xref.build(bytes)
        let (_, catalog) = try PdfReader.catalog(bytes)
        let pages = Dictionary(uniqueKeysWithValues: PdfReader.pages(bytes, xref, catalog).enumerated().map { ($1, $0) })
        let rootNumber = PdfReader.reference(catalog, "StructTreeRoot")
        guard let root = rootNumber.flatMap({ PdfReader.object(bytes, xref, $0) }) ?? PdfReader.entry(catalog, "StructTreeRoot"),
              case .dictionary = root else { return [] }

        var found: [Figure] = []
        var seen = Set<Int>()
        var parents: [Int: Int?] = [:]
        if let rootNumber { seen.insert(rootNumber) }

        func resolve(_ value: PdfValue) -> (PdfValue?, Int?) {
            guard case .reference(let number, _) = value else { return (value, nil) }
            guard seen.insert(number).inserted else { return (nil, number) }
            return (PdfReader.object(bytes, xref, number), number)
        }

        func kids(_ node: PdfValue) -> [PdfValue] {
            switch PdfReader.entry(node, "K") {
            case .array(let items)?: return items
            case let single?: return [single]
            case nil: return []
            }
        }

        func visit(_ node: PdfValue, _ number: Int?, _ page: Int?, _ depth: Int) {
            guard depth <= maxDepth else { return }
            let ownPage = PdfReader.reference(node, "Pg") ?? page
            var ids: [(Int?, Int)] = []

            for kid in kids(node) {
                if case .integer(let id) = kid { ids.append((ownPage, id)); continue }
                let (child, childNumber) = resolve(kid)
                guard let child, case .dictionary = child else { continue }
                let type = PdfReader.entry(child, "Type")
                let isMcr = type.map { PdfReader.isName($0, "MCR") } ?? false
                let hasStructureType = PdfReader.entry(child, "S") != nil
                if isMcr || !hasStructureType, case .integer(let id)? = PdfReader.entry(child, "MCID") {
                    ids.append((PdfReader.reference(child, "Pg") ?? ownPage, id))
                } else if hasStructureType, !(type.map { PdfReader.isName($0, "OBJR") } ?? false) {
                    visit(child, childNumber, ownPage, depth + 1)
                    if let childNumber { parents[childNumber] = number }
                }
            }

            guard let s = PdfReader.entry(node, "S"), PdfReader.isName(s, "Figure"),
                  let number, !ids.isEmpty else { return }
            let pageNumbers = Set(ids.map { $0.0 })
            guard pageNumbers.count == 1, let only = pageNumbers.first!, let pageIndex = pages[only] else { return }
            found.append(Figure(number: number, parent: nil, pageIndex: pageIndex, ids: ids.map { $0.1 }))
        }

        for kid in kids(root) {
            let (child, childNumber) = resolve(kid)
            guard let child, PdfReader.entry(child, "S") != nil else { continue }
            visit(child, childNumber, nil, 1)
            if let childNumber { parents[childNumber] = rootNumber }
        }
        return found.map { Figure(number: $0.number, parent: parents[$0.number] ?? nil, pageIndex: $0.pageIndex, ids: $0.ids) }
    }

    /// The figure each edit names. Throws before anything is written when one is missing or ambiguous.
    static func find(_ bytes: [UInt8], _ edits: [Edit]) throws -> [Figure] {
        let all = try figures(bytes)
        return try edits.map { edit in
            let matches = all.filter { $0.pageIndex == edit.pageIndex && $0.ids.sorted() == edit.markedContentIds.sorted() }
            let label = "page \(edit.pageIndex), marked content \(edit.markedContentIds.map(String.init).joined(separator: ","))"
            guard !matches.isEmpty else { throw NotFound(reason: "no figure on \(label)") }
            guard matches.count == 1 else { throw NotFound(reason: "\(matches.count) figures on \(label)") }
            if edit.decorative, matches[0].parent == nil {
                throw NotFound(reason: "the figure on \(label) has no indirect parent to remove it from")
            }
            return matches[0]
        }
    }

    /// Appends /Alt for described figures and removes decorative ones from their parents.
    static func write(_ base: Data, _ edits: [Edit]) throws -> Data {
        let bytes = [UInt8](base)
        let targets = try find(bytes, edits)
        let xref = try Xref.build(bytes)
        var objects: [Int: PdfValue] = [:]
        func current(_ number: Int) throws -> [(String, PdfValue)] {
            guard case .dictionary(let entries)? = objects[number] ?? PdfReader.object(bytes, xref, number) else {
                throw NotFound(reason: "object \(number) is unreadable")
            }
            return entries
        }

        for (edit, target) in zip(edits, targets) {
            if edit.decorative, let parent = target.parent {
                let entries = try current(parent)
                let kids: [PdfValue]
                switch entries.first(where: { $0.0 == "K" })?.1 {
                case .array(let items)?: kids = items
                case let single?: kids = [single]
                case nil: kids = []
                }
                let kept = kids.filter { if case .reference(let n, _) = $0 { return n != target.number }; return true }
                objects[parent] = .dictionary(entries.filter { $0.0 != "K" } + [("K", .array(kept))])
            } else {
                let entries = try current(target.number)
                objects[target.number] = .dictionary(entries.filter { $0.0 != "Alt" } + [("Alt", .string(edit.altText ?? ""))])
            }
        }
        return try PdfWriter.appendUpdate(to: base, objects: objects)
    }
}
