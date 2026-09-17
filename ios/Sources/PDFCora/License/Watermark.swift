import Foundation
@_implementationOnly import CPdfium

/// The trial watermark, drawn with PDFium so it looks the same on every platform.
enum Watermark {
    private static let text = "PDFCora trial"

    /// Adds the watermark to `page`, centred on the box and running along its diagonal.
    private static func place(in document: FPDF_DOCUMENT, page: FPDF_PAGE,
                              left: Float, bottom: Float, width: Float, height: Float) {
        guard let object = FPDFPageObj_NewTextObj(document, "Helvetica-Bold", 100) else { return }
        var units = Array(text.utf16) + [0]
        units.withUnsafeMutableBufferPointer { _ = FPDFText_SetText(object, $0.baseAddress) }
        FPDFPageObj_SetFillColor(object, 128, 128, 128, 64)

        var l: Float = 0, b: Float = 0, r: Float = 0, t: Float = 0
        FPDFPageObj_GetBounds(object, &l, &b, &r, &t)
        let angle = atan2(Double(height), Double(width))
        let scale = hypot(Double(width), Double(height)) * 0.6 / max(1, Double(r - l))
        let c = cos(angle) * scale
        let s = sin(angle) * scale
        FPDFPageObj_Transform(object, 1, 0, 0, 1, -Double(l + r) / 2, -Double(b + t) / 2)
        FPDFPageObj_Transform(object, c, s, -s, c,
                              Double(left) + Double(width) / 2, Double(bottom) + Double(height) / 2)
        // PDF/UA: the watermark is decoration, so it is an artifact rather than untagged
        // content (7.1-3). Without the mark, remediated trial output fails on every page.
        FPDFPageObj_AddMark(object, "Artifact")
        FPDFPage_InsertObject(page, object)
        FPDFPage_GenerateContent(page)
    }

    /// Draws over an already rendered bitmap; the document is not touched.
    static func draw(on bitmap: FPDF_BITMAP, width: Int32, height: Int32) {
        guard let scratch = FPDF_CreateNewDocument() else { return }
        defer { FPDF_CloseDocument(scratch) }
        guard let page = FPDFPage_New(scratch, 0, Double(width), Double(height)) else { return }
        place(in: scratch, page: page, left: 0, bottom: 0, width: Float(width), height: Float(height))
        FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
        FPDF_ClosePage(page)
    }

    /// A full save of `data` with the watermark in every page's content.
    static func stamp(_ data: Data) throws -> Data {
        try data.withUnsafeBytes { raw in
            guard let document = FPDF_LoadMemDocument(raw.baseAddress, Int32(data.count), nil) else {
                throw PdfError.saveFailed(reason: "the saved document could not be reopened to watermark it")
            }
            defer { FPDF_CloseDocument(document) }
            for index in 0..<FPDF_GetPageCount(document) {
                guard let page = FPDF_LoadPage(document, index) else { continue }
                var l: Float = 0, b: Float = 0, r: Float = 0, t: Float = 0
                let hasBox = FPDFPage_GetMediaBox(page, &l, &b, &r, &t) != 0
                place(in: document, page: page, left: hasBox ? l : 0, bottom: hasBox ? b : 0,
                      width: FPDF_GetPageWidthF(page), height: FPDF_GetPageHeightF(page))
                FPDF_ClosePage(page)
            }
            return try PdfDocument.serialise(document, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL))
        }
    }
}
