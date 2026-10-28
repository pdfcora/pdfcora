import Foundation
@_implementationOnly import CPdfium

/// What a page object is, as PDFium classifies it.
public enum PdfPageObjectKind: Sendable {
    case text, path, image, shading, form, unknown
}

/// One object a page is drawn from.
///
/// Redaction resolves a region to the objects it touches and removes or rewrites them,
/// which is what makes the content actually leave the file.
public struct PdfPageObject: Sendable, Equatable {
    /// Position in the page's object list, which is how it is addressed for removal.
    public let index: Int
    public let kind: PdfPageObjectKind
    /// In PDF space, normalised so left <= right and bottom <= top.
    public let bounds: PdfRect
    /// Present for text objects only.
    public let text: String?
    public let fontSize: Double?
}

/// What to remove.
public enum PdfRedactionTarget: Equatable, Sendable {
    case region(PdfRect, pageIndex: Int)
    case textMatches(String, options: PdfSearchOptions = .none)
}

/// What redaction actually removed.
///
/// Not decoration: redaction is a compliance action, and "what did it remove" is the
/// question every reviewer asks.
public struct PdfRedactionReport: Sendable, Equatable {
    public let pages: [Int]
    /// Removed outright.
    public let textObjects: Int
    /// Partially covered, so rewritten with the covered characters dropped.
    public let textObjectsSplit: Int
    /// Images are removed whole, never repainted with a hole.
    public let images: Int
    public let paths: Int
    public let annotations: Int
    public let formFields: [String]
    public let attachments: [String]
}

extension PdfDocument {
    /// The objects a page is drawn from, in drawing order.
    public func pageObjects(at pageIndex: Int) throws -> [PdfPageObject] {
        let page = try loadedPage(pageIndex)
        let textPage = FPDFText_LoadPage(page)
        defer { if let textPage { FPDFText_ClosePage(textPage) } }
        return Redactor.objects(page: page, textPage: textPage)
    }

    /// Removes content, so that it cannot be recovered.
    ///
    /// **Save with ``PdfSaveMode/full`` afterwards.** An incremental save does not write
    /// the regenerated content stream at all, so the removed content stays in the file.
    public func redact(_ targets: [PdfRedactionTarget]) throws -> PdfRedactionReport {
        let document = try requireHandle()
        var counts = Redactor.Counts()

        let pages = Int(FPDF_GetPageCount(document))
        for case .region(_, let pageIndex) in targets where pageIndex < 0 || pageIndex >= pages {
            throw PdfError.pageOutOfRange(pageIndex, count: pages)
        }

        for pageIndex in 0..<pages {
            var regions = targets.compactMap { target -> PdfRect? in
                if case .region(let rect, let index) = target, index == pageIndex { return rect }
                return nil
            }

            let page = try loadedPage(pageIndex)
            let textPage = FPDFText_LoadPage(page)
            defer { if let textPage { FPDFText_ClosePage(textPage) } }

            // A search target becomes regions: every match's rects on this page.
            for case .textMatches(let query, let options) in targets {
                // Reuse the SDK's own search rather than a second implementation that
                // could drift from it.
                let matches = try textSearch(pageIndex, query, options)
                regions += matches.flatMap { $0.rects }
            }
            guard !regions.isEmpty else { continue }

            let changed = Redactor.redact(
                document: document, page: page, textPage: textPage,
                regions: regions, counts: &counts)
            Redactor.scrubAnnotations(page: page, regions: regions, counts: &counts)
            if changed { counts.pages.append(pageIndex) }
        }

        let needles = targets.compactMap { target -> String? in
            if case .textMatches(let query, _) = target, !query.isEmpty { return query }
            return nil
        }
        if !needles.isEmpty {
            Redactor.scrubAttachments(document: document, needles: needles, counts: &counts)
        }

        return counts.report()
    }
}

enum Redactor {
    struct Counts {
        var textObjects = 0, textObjectsSplit = 0, images = 0, paths = 0, annotations = 0
        var formFields: [String] = [], attachments: [String] = [], pages: [Int] = []

        func report() -> PdfRedactionReport {
            PdfRedactionReport(
                pages: pages.sorted(), textObjects: textObjects,
                textObjectsSplit: textObjectsSplit, images: images, paths: paths,
                annotations: annotations, formFields: formFields, attachments: attachments)
        }
    }

    /// Touching edges count as overlapping, deliberately.
    static func intersects(_ a: PdfRect, _ b: PdfRect) -> Bool {
        a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom
    }

    static func objects(page: FPDF_PAGE, textPage: FPDF_TEXTPAGE?) -> [PdfPageObject] {
        let count = Int(FPDFPage_CountObjects(page))
        guard count > 0 else { return [] }

        return (0..<count).compactMap { index in
            guard let handle = FPDFPage_GetObject(page, Int32(index)) else { return nil }
            let type = FPDFPageObj_GetType(handle)
            let kind: PdfPageObjectKind = switch type {
            case 1: .text
            case 2: .path
            case 3: .image
            case 4: .shading
            case 5: .form
            default: .unknown
            }

            return PdfPageObject(
                index: index, kind: kind, bounds: bounds(of: handle),
                text: kind == .text ? text(of: handle, textPage: textPage) : nil,
                fontSize: kind == .text ? fontSize(of: handle) : nil)
        }
    }

    /// PDFium returns whichever corners it holds, so they are normalised here and every
    /// intersection test downstream can assume the usual ordering.
    private static func bounds(of handle: FPDF_PAGEOBJECT) -> PdfRect {
        var left: Float = 0, bottom: Float = 0, right: Float = 0, top: Float = 0
        FPDFPageObj_GetBounds(handle, &left, &bottom, &right, &top)
        return PdfRect(
            left: Double(min(left, right)), bottom: Double(min(bottom, top)),
            right: Double(max(left, right)), top: Double(max(bottom, top)))
    }

    private static func text(of handle: FPDF_PAGEOBJECT, textPage: FPDF_TEXTPAGE?) -> String? {
        guard let textPage else { return nil }
        let size = FPDFTextObj_GetText(handle, textPage, nil, 0)
        // PDFium returns the terminator alone when there is no text.
        guard size > 2 else { return nil }

        var units = [UInt16](repeating: 0, count: Int(size) / 2)
        _ = units.withUnsafeMutableBufferPointer {
            FPDFTextObj_GetText(handle, textPage, $0.baseAddress, size)
        }
        if units.last == 0 { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    private static func fontSize(of handle: FPDF_PAGEOBJECT) -> Double? {
        var size: Float = 0
        guard FPDFTextObj_GetFontSize(handle, &size) != 0 else { return nil }
        return Double(size)
    }
}
