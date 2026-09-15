import Foundation
@_implementationOnly import CPdfium

/// An element of a tagged PDF's structure tree, as seen from one page.
public struct PdfStructureElement: Equatable, Sendable {
    /// The structure type as written (`/S`), such as `P`, `H1` or `Figure`; role maps are not applied.
    public let type: String
    public let altText: String?
    public let actualText: String?
    public let title: String?
    public let language: String?
    /// Marked-content ids of this element's own content on the page.
    public let markedContentIds: [Int]
    /// Union of the page objects carrying this element's or its descendants' content.
    public let bounds: PdfRect?
    public let children: [PdfStructureElement]
}

/// A figure, named by its page and marked-content ids, and what to write for it.
public struct PdfFigureEdit: Equatable, Sendable {
    public enum Change: Equatable, Sendable {
        case altText(String)
        case decorative
    }

    public let pageIndex: Int
    public let markedContentIds: [Int]
    public let change: Change

    public init(pageIndex: Int, markedContentIds: [Int], change: Change) {
        self.pageIndex = pageIndex
        self.markedContentIds = markedContentIds
        self.change = change
    }
}

extension PdfPage {
    /// The page's structure tree: the elements of a tagged PDF that have content on this page.
    /// Empty for an untagged document.
    public func structure() async throws -> [PdfStructureElement] {
        try await document.structure(pageIndex: index)
    }
}

extension PdfDocument {
    /// True when the document declares itself tagged (`/MarkInfo /Marked`).
    public var isTagged: Bool {
        get throws { FPDFCatalog_IsTagged(try requireHandle()) != 0 }
    }

    func structure(pageIndex: Int) throws -> [PdfStructureElement] {
        let page = try loadedPage(pageIndex)
        guard let tree = FPDF_StructTree_GetForPage(page) else { return [] }
        defer { FPDF_StructTree_Close(tree) }
        let bounds = StructureReader.boundsByMarkedContentId(page)
        return (0..<max(0, Int(FPDF_StructTree_CountChildren(tree)))).compactMap { i in
            FPDF_StructTree_GetChildAtIndex(tree, Int32(i)).map { StructureReader.element($0, bounds, depth: 0) }
        }
    }

    /// Writes alternate text for figures, or marks them decorative, returning a new document.
    /// This document is left unchanged.
    ///
    /// A figure is named by its page and marked-content ids, as ``PdfPage/structure()`` reports
    /// them. Every edit is checked first; one that matches no figure, or several, throws
    /// ``PdfError/invalidOperation(reason:)`` and nothing is written. Decorative figures have
    /// their content re-marked as an artifact and are removed from the structure tree; that
    /// regenerates the page, so earlier signatures stop verifying. Description-only edits are
    /// appended as an incremental update.
    public func updateFigures(_ edits: [PdfFigureEdit]) async throws -> PdfDocument {
        use(.editing)
        let handle = try requireHandle()
        let pages = Int(FPDF_GetPageCount(handle))
        for edit in edits where edit.pageIndex < 0 || edit.pageIndex >= pages {
            throw PdfError.pageOutOfRange(edit.pageIndex, count: pages)
        }
        let writes = edits.map { edit -> FigureWriter.Edit in
            if case .altText(let text) = edit.change {
                return .init(pageIndex: edit.pageIndex, markedContentIds: edit.markedContentIds, altText: text, decorative: false)
            }
            return .init(pageIndex: edit.pageIndex, markedContentIds: edit.markedContentIds, altText: nil, decorative: true)
        }
        let decorative = writes.filter(\.decorative)

        do {
            if let form { FORM_ForceToKillFocus(form) }
            var base = try Self.serialise(handle, flags: FPDF_DWORD(decorative.isEmpty ? FPDF_INCREMENTAL : FPDF_NO_INCREMENTAL))
            _ = try FigureWriter.find([UInt8](base), writes)

            if !decorative.isEmpty {
                let scratch = try await PdfDocument(data: base)
                for pageIndex in Set(decorative.map(\.pageIndex)) {
                    let ids = Set(decorative.filter { $0.pageIndex == pageIndex }.flatMap(\.markedContentIds))
                    try await scratch.markArtifacts(pageIndex: pageIndex, ids: ids)
                }
                base = try await scratch.unwatermarkedData()
                await scratch.close()
            }

            let updated = try await PdfDocument(data: try FigureWriter.write(base, writes))
            if needsWatermark { await updated.markNeedsWatermark() }
            return updated
        } catch let error as FigureWriter.NotFound {
            throw PdfError.invalidOperation(reason: error.reason)
        }
    }

    func unwatermarkedData() throws -> Data {
        try Self.serialise(try requireHandle(), flags: FPDF_DWORD(FPDF_NO_INCREMENTAL))
    }

    /// Re-marks every top-level object whose marked content has one of `ids` as an artifact,
    /// and regenerates the page's content.
    func markArtifacts(pageIndex: Int, ids: Set<Int>) throws {
        let page = try loadedPage(pageIndex)
        var changed = false
        for i in 0..<max(0, Int(FPDFPage_CountObjects(page))) {
            guard let object = FPDFPage_GetObject(page, Int32(i)) else { continue }
            for k in stride(from: Int(FPDFPageObj_CountMarks(object)) - 1, through: 0, by: -1) {
                guard let mark = FPDFPageObj_GetMark(object, UInt(k)) else { continue }
                var id: Int32 = -1
                guard FPDFPageObjMark_GetParamIntValue(mark, "MCID", &id) != 0, ids.contains(Int(id)) else { continue }
                FPDFPageObj_RemoveMark(object, mark)
                FPDFPageObj_AddMark(object, "Artifact")
                changed = true
                break
            }
        }
        if changed { FPDFPage_GenerateContent(page) }
    }
}

private enum StructureReader {
    static let maxDepth = 64

    static func element(_ element: FPDF_STRUCTELEMENT, _ bounds: [Int: PdfRect], depth: Int) -> PdfStructureElement {
        func text(_ getter: (FPDF_STRUCTELEMENT?, UnsafeMutableRawPointer?, UInt) -> UInt) -> String? {
            let size = getter(element, nil, 0)
            guard size > 2 else { return nil }
            var buffer = [UInt16](repeating: 0, count: Int(size) / 2)
            _ = buffer.withUnsafeMutableBytes { getter(element, $0.baseAddress, size) }
            let value = String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF16.self)
            return value.isEmpty ? nil : value
        }

        let ids = (0..<max(0, Int(FPDF_StructElement_GetMarkedContentIdCount(element)))).compactMap { i -> Int? in
            let id = Int(FPDF_StructElement_GetMarkedContentIdAtIndex(element, Int32(i)))
            return id >= 0 ? id : nil
        }
        let children = depth >= maxDepth ? [] : (0..<max(0, Int(FPDF_StructElement_CountChildren(element)))).compactMap { i in
            FPDF_StructElement_GetChildAtIndex(element, Int32(i)).map { self.element($0, bounds, depth: depth + 1) }
        }
        let rect = (ids.compactMap { bounds[$0] } + children.compactMap(\.bounds)).reduce(nil as PdfRect?) { all, r in
            all.map { union($0, r) } ?? r
        }
        return PdfStructureElement(
            type: text(FPDF_StructElement_GetType) ?? "",
            altText: text(FPDF_StructElement_GetAltText),
            actualText: text(FPDF_StructElement_GetActualText),
            title: text(FPDF_StructElement_GetTitle),
            language: text(FPDF_StructElement_GetLang),
            markedContentIds: ids, bounds: rect, children: children)
    }

    static func boundsByMarkedContentId(_ page: FPDF_PAGE) -> [Int: PdfRect] {
        var result: [Int: PdfRect] = [:]
        for i in 0..<max(0, Int(FPDFPage_CountObjects(page))) {
            guard let object = FPDFPage_GetObject(page, Int32(i)) else { continue }
            let id = Int(FPDFPageObj_GetMarkedContentID(object))
            guard id >= 0 else { continue }
            var l: Float = 0, b: Float = 0, r: Float = 0, t: Float = 0
            FPDFPageObj_GetBounds(object, &l, &b, &r, &t)
            let rect = PdfRect(left: Double(min(l, r)), bottom: Double(min(b, t)), right: Double(max(l, r)), top: Double(max(b, t)))
            result[id] = result[id].map { union($0, rect) } ?? rect
        }
        return result
    }

    static func union(_ a: PdfRect, _ b: PdfRect) -> PdfRect {
        PdfRect(left: min(a.left, b.left), bottom: min(a.bottom, b.bottom), right: max(a.right, b.right), top: max(a.top, b.top))
    }
}
