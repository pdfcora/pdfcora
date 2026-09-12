import Foundation
import CPdfium

/// A page within a document.
///
/// This is a lightweight reference, not a live PDFium handle: it holds the owning
/// document and a page index. Every operation runs on the document's actor, so a page
/// can be passed between tasks freely and can never be used after its document closes
/// without raising ``PdfError/closed``.
public struct PdfPage: Sendable {
    public let document: PdfDocument
    public let index: Int

    init(document: PdfDocument, index: Int) {
        self.document = document
        self.index = index
    }

    /// Page size in points.
    public var size: PdfSize {
        get async throws { try await document.pageSize(at: index) }
    }

    public var rotation: PdfPageRotation {
        get async throws { try await document.pageRotation(at: index) }
    }

    public func setRotation(_ rotation: PdfPageRotation) async throws {
        try await document.setPageRotation(rotation, at: index)
    }

    /// Text extraction and search for this page.
    public var text: PdfTextPage { PdfTextPage(document: document, pageIndex: index) }

    /// Releases the underlying PDFium page. Optional — closing the document does this too.
    public func unload() async {
        await document.releasePage(index)
    }
}

/// A page size in points.
public struct PdfSize: Equatable, Sendable {
    public var width: Double
    public var height: Double
    public init(width: Double, height: Double) { self.width = width; self.height = height }
}

extension PdfDocument {
    func pageSize(at index: Int) throws -> PdfSize {
        let page = try loadedPage(index)
        return PdfSize(width: Double(FPDF_GetPageWidthF(page)),
                       height: Double(FPDF_GetPageHeightF(page)))
    }

    func pageRotation(at index: Int) throws -> PdfPageRotation {
        let page = try loadedPage(index)
        return PdfPageRotation(rawValue: Int(FPDFPage_GetRotation(page))) ?? .none
    }

    func setPageRotation(_ rotation: PdfPageRotation, at index: Int) throws {
        let page = try loadedPage(index)
        FPDFPage_SetRotation(page, Int32(rotation.rawValue))
    }
}
