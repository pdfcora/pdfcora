import Foundation

/// Writing a new structure tree for content PDFium has already marked.
///
/// PDFium puts the marked-content ids into the page content; the tree that points at them is
/// dictionaries, which only this writer can create.
enum TagTreeWriter {
    struct Block {
        let pageIndex: Int
        let type: String
        /// The marked-content ids PDFium gave this block's objects.
        let mcids: [Int]
        let altText: String?
    }

    struct Tree {
        /// In reading order, artifacts excluded.
        let blocks: [Block]
        /// Marked-content ids used on each page.
        let mcidCounts: [Int]
        let title: String
        /// Written to /Lang; nil keeps the Catalog's own.
        let language: String?
    }

    static func write(_ base: Data, _ tree: Tree) throws -> Data {
        let bytes = [UInt8](base)
        let info = try TrailerInfo.scan(base)
        let xref = try Xref.build(bytes)
        let (catalogNumber, catalog) = try PdfReader.catalog(bytes)
        let pages = PdfReader.pages(bytes, xref, catalog)

        var next = info.nextObjectNumber
        func allocate() -> Int { defer { next += 1 }; return next }
        let rootNumber = allocate(), documentNumber = allocate(), metadataNumber = allocate()

        var objects: [Int: PdfValue] = [:]
        var documentKids: [PdfValue] = []
        var parents: [[PdfValue]] = tree.mcidCounts.map { Array(repeating: .null, count: $0) }
        func element(_ type: String, parent: Int, _ rest: [(String, PdfValue)]) -> PdfValue {
            .dictionary([("Type", .name("StructElem")), ("S", .name(type)), ("P", .reference(parent))] + rest)
        }

        var list: (number: Int, kids: [PdfValue])?
        for block in tree.blocks {
            let holder = allocate()
            let content: [(String, PdfValue)] = [("Pg", .reference(pages[block.pageIndex])), ("K", .array(block.mcids.map { .integer($0) }))]
            for id in block.mcids { parents[block.pageIndex][id] = .reference(holder) }

            guard block.type == "LI" else {
                list = nil
                objects[holder] = element(block.type, parent: documentNumber,
                                          content + (block.altText.map { [("Alt", .string($0))] } ?? []))
                documentKids.append(.reference(holder))
                continue
            }
            if list == nil {
                list = (allocate(), [])
                documentKids.append(.reference(list!.number))
            }
            let item = allocate()
            list!.kids.append(.reference(item))
            objects[item] = element("LI", parent: list!.number, [("K", .array([.reference(holder)]))])
            objects[holder] = element("LBody", parent: item, content)
            objects[list!.number] = element("L", parent: documentNumber, [("K", .array(list!.kids))])
        }

        let parentTree = allocate()
        objects[parentTree] = .dictionary([("Nums", .array(parents.enumerated().flatMap { [.integer($0.offset), .array($0.element)] }))])
        objects[documentNumber] = element("Document", parent: rootNumber, [("K", .array(documentKids))])
        objects[rootNumber] = .dictionary([
            ("Type", .name("StructTreeRoot")), ("K", .reference(documentNumber)),
            ("ParentTree", .reference(parentTree)), ("ParentTreeNextKey", .integer(pages.count)),
        ])

        for (pageIndex, number) in pages.enumerated() {
            guard case .dictionary(let entries)? = PdfReader.object(bytes, xref, number) else {
                throw PdfError.saveFailed(reason: "tagging: page \(pageIndex) is unreadable")
            }
            objects[number] = .dictionary(entries.filter { $0.0 != "StructParents" && $0.0 != "Tabs" }
                + [("StructParents", .integer(pageIndex)), ("Tabs", .name("S"))])
        }

        let xmp = Data(xmpPacket(tree.title).utf8)
        var metadata = Data("<</Type /Metadata /Subtype /XML /Length \(xmp.count)>>\nstream\n".utf8)
        metadata.append(xmp)
        metadata.append(Data("\nendstream".utf8))
        objects[metadataNumber] = .raw(metadata)

        guard case .dictionary(let catalogEntries) = catalog else { throw PdfError.saveFailed(reason: "tagging: no catalog") }
        let replaced = Set(["StructTreeRoot", "MarkInfo", "Metadata"] + (tree.language == nil ? [] : ["Lang"]))
        var entries = catalogEntries.filter { !replaced.contains($0.0) }
        entries += [("StructTreeRoot", .reference(rootNumber)),
                    ("MarkInfo", .dictionary([("Marked", .boolean(true))])),
                    ("Metadata", .reference(metadataNumber))]
        if let language = tree.language { entries.append(("Lang", .string(language))) }

        func withDisplayTitle(_ value: PdfValue?) -> PdfValue {
            guard case .dictionary(let existing)? = value else { return .dictionary([("DisplayDocTitle", .boolean(true))]) }
            return .dictionary(existing.filter { $0.0 != "DisplayDocTitle" } + [("DisplayDocTitle", .boolean(true))])
        }
        if let preferences = PdfReader.reference(catalog, "ViewerPreferences") {
            objects[preferences] = withDisplayTitle(PdfReader.object(bytes, xref, preferences))
        } else {
            entries = entries.filter { $0.0 != "ViewerPreferences" } + [("ViewerPreferences", withDisplayTitle(PdfReader.entry(catalog, "ViewerPreferences")))]
        }
        objects[catalogNumber] = .dictionary(entries)

        return try PdfWriter.appendUpdate(to: base, objects: objects)
    }

    static func xmpPacket(_ title: String) -> String {
        let escaped = title.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        return """
        <?xpacket begin="\u{feff}" id="W5M0MpCehiHzreSzNTczkc9d"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/">
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
        <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
        <dc:title><rdf:Alt><rdf:li xml:lang="x-default">\(escaped)</rdf:li></rdf:Alt></dc:title>
        <pdfuaid:part>1</pdfuaid:part>
        </rdf:Description>
        </rdf:RDF>
        </x:xmpmeta>
        <?xpacket end="w"?>
        """
    }
}
