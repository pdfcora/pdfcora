import Foundation
@_implementationOnly import CPdfium

/// Structure types remediation writes. `li` blocks in a row become one list.
public enum PdfTagType: String, Sendable, Equatable, CaseIterable {
    case h1 = "H1", h2 = "H2", h3 = "H3", h4 = "H4", h5 = "H5", h6 = "H6"
    case p = "P", li = "LI", figure = "Figure", artifact = "Artifact"
}

/// Page objects to tag as one structure element, in reading order.
public struct PdfTagBlock: Sendable, Equatable {
    public let pageIndex: Int
    public let type: PdfTagType
    /// Indices from ``PdfDocument/pageObjects(at:)``.
    public let objectIndices: [Int]
    /// Figures only.
    public let altText: String?

    public init(pageIndex: Int, type: PdfTagType, objectIndices: [Int], altText: String? = nil) {
        self.pageIndex = pageIndex
        self.type = type
        self.objectIndices = objectIndices
        self.altText = altText
    }
}

extension PdfDocument {
    /// Tags an untagged document's content as a structure tree, returning a new document. This
    /// document is left unchanged.
    ///
    /// `blocks` are in reading order; consecutive `li` blocks become one list. Every page object
    /// not in a block, and every object in an `artifact` block, is marked as an artifact. Throws
    /// ``PdfError/invalidOperation(reason:)``, writing nothing, when the document is already
    /// tagged, an object index is out of range or listed twice, `altText` is given for a
    /// non-figure, or there is no title or language (given or already in the document). The pages
    /// are regenerated, so earlier signatures stop verifying.
    ///
    /// - Parameters:
    ///   - title: written to the XMP metadata; defaults to the document's title.
    ///   - language: BCP 47, written to `/Lang`; defaults to the document's own `/Lang`.
    public func tagContent(_ blocks: [PdfTagBlock], title: String? = nil, language: String? = nil) async throws -> PdfDocument {
        let handle = try requireHandle()
        if FPDFCatalog_IsTagged(handle) != 0 { throw PdfError.invalidOperation(reason: "the document is already tagged") }
        let pageCount = Int(FPDF_GetPageCount(handle))
        let objectCounts = try (0..<pageCount).map { Int(FPDFPage_CountObjects(try loadedPage($0))) }

        var seen = Set<[Int]>()
        for block in blocks {
            guard block.pageIndex >= 0, block.pageIndex < pageCount else { throw PdfError.pageOutOfRange(block.pageIndex, count: pageCount) }
            if block.altText != nil, block.type != .figure {
                throw PdfError.invalidOperation(reason: "alt text is for figures, not \(block.type.rawValue)")
            }
            for index in block.objectIndices {
                guard index >= 0, index < objectCounts[block.pageIndex] else {
                    throw PdfError.invalidOperation(reason: "no object \(block.pageIndex):\(index)")
                }
                guard seen.insert([block.pageIndex, index]).inserted else {
                    throw PdfError.invalidOperation(reason: "object \(block.pageIndex):\(index) is in two blocks")
                }
            }
        }

        let existingTitle = try metadata.title
        guard let title = title ?? existingTitle, !title.isEmpty else {
            throw PdfError.invalidOperation(reason: "a title is needed: the document has none")
        }
        if let form { FORM_ForceToKillFocus(form) }
        var base = try Self.serialise(handle, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL))
        if language == nil, PdfReader.entry(try PdfReader.catalog([UInt8](base)).value, "Lang") == nil {
            throw PdfError.invalidOperation(reason: "a language is needed: the document has no /Lang")
        }

        var mcidCounts = Array(repeating: 0, count: pageCount)
        var tagged: [TagTreeWriter.Block] = []
        var marks = Array(repeating: [(index: Int, tag: String, mcid: Int)](), count: pageCount)
        for block in blocks {
            var mcids: [Int] = []
            for index in block.objectIndices {
                if block.type == .artifact {
                    marks[block.pageIndex].append((index, "Artifact", -1))
                } else {
                    mcids.append(mcidCounts[block.pageIndex])
                    marks[block.pageIndex].append((index, block.type == .li ? "LBody" : block.type.rawValue, mcidCounts[block.pageIndex]))
                    mcidCounts[block.pageIndex] += 1
                }
            }
            if block.type != .artifact {
                tagged.append(.init(pageIndex: block.pageIndex, type: block.type.rawValue, mcids: mcids, altText: block.altText))
            }
        }
        for pageIndex in 0..<pageCount {
            for index in 0..<objectCounts[pageIndex] where !seen.contains([pageIndex, index]) {
                marks[pageIndex].append((index, "Artifact", -1))
            }
        }

        let scratch = try await PdfDocument(data: base)
        for pageIndex in 0..<pageCount {
            try await scratch.markTags(pageIndex: pageIndex, marks: marks[pageIndex].map { MarkedObject(index: $0.index, tag: $0.tag, mcid: $0.mcid) })
        }
        base = try await scratch.data()
        await scratch.close()

        let updated = try await PdfDocument(data: try TagTreeWriter.write(base, .init(
            blocks: tagged, mcidCounts: mcidCounts, title: title, language: language)))
        return updated
    }

    struct MarkedObject: Sendable { let index: Int; let tag: String; let mcid: Int }

    /// Gives each listed object a content mark named `tag`, with an `MCID` parameter unless
    /// `mcid` is negative, and regenerates the page's content.
    func markTags(pageIndex: Int, marks: [MarkedObject]) throws {
        let document = try requireHandle()
        let page = try loadedPage(pageIndex)
        for mark in marks {
            guard let object = FPDFPage_GetObject(page, Int32(mark.index)),
                  let added = FPDFPageObj_AddMark(object, mark.tag) else { continue }
            if mark.mcid >= 0 { FPDFPageObjMark_SetIntParam(document, object, added, "MCID", Int32(mark.mcid)) }
        }
        FPDFPage_GenerateContent(page)
    }
}
