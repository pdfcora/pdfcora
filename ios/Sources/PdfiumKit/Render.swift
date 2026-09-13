import Foundation
import CoreGraphics
import UIKit
@_implementationOnly import CPdfium

extension PdfPage {
    /// Renders the page at `width` points; height follows the page aspect ratio.
    ///
    /// Runs on the document's actor, so it never blocks the caller's thread. Honours
    /// task cancellation between progressive render steps.
    public func render(width: Int,
                       options: PdfRenderOptions = .default,
                       background: PdfColor = PdfColor(red: 255, green: 255, blue: 255)) async throws -> UIImage {
        try await document.render(pageIndex: index, width: width, options: options, background: background)
    }

    /// Renders at an explicit pixel size, ignoring the page aspect ratio.
    public func render(pixelWidth: Int,
                       pixelHeight: Int,
                       options: PdfRenderOptions = .default,
                       background: PdfColor = PdfColor(red: 255, green: 255, blue: 255)) async throws -> UIImage {
        try await document.render(pageIndex: index, pixelSize: (pixelWidth, pixelHeight),
                                  options: options, background: background)
    }
}

extension PdfDocument {
    func render(pageIndex: Int,
                width: Int,
                options: PdfRenderOptions,
                background: PdfColor) throws -> UIImage {
        let size = try pageSize(at: pageIndex)
        guard size.width > 0, size.height > 0 else {
            throw PdfError.corrupt(detail: "page \(pageIndex) has zero size")
        }
        let scale = Double(width) / size.width
        let pixelHeight = max(1, Int((size.height * scale).rounded()))
        return try render(pageIndex: pageIndex, pixelSize: (max(1, width), pixelHeight),
                          options: options, background: background)
    }

    func render(pageIndex: Int,
                pixelSize: (width: Int, height: Int),
                options: PdfRenderOptions,
                background: PdfColor) throws -> UIImage {
        let page = try loadedPage(pageIndex)
        let w = Int32(pixelSize.width)
        let h = Int32(pixelSize.height)

        guard let bitmap = FPDFBitmap_CreateEx(w, h, Int32(FPDFBitmap_BGRA), nil, w * 4) else {
            throw PdfError.engine(code: -1)
        }
        defer { FPDFBitmap_Destroy(bitmap) }

        // FPDFBitmap_FillRect takes 0xAARRGGBB.
        let fill = (UInt(background.alpha) << 24) | (UInt(background.red) << 16)
                 | (UInt(background.green) << 8) | UInt(background.blue)
        FPDFBitmap_FillRect(bitmap, 0, 0, w, h, fill)

        var flags: Int32 = 0
        if options.contains(.annotations) { flags |= Int32(FPDF_ANNOT) }
        if options.contains(.grayscale) { flags |= Int32(FPDF_GRAYSCALE) }
        if options.contains(.noTextSmoothing) { flags |= Int32(FPDF_RENDER_NO_SMOOTHTEXT) }

        try renderProgressively(bitmap: bitmap, page: page, width: w, height: h, flags: flags)

        if options.contains(.forms), let form {
            FPDF_FFLDraw(form, bitmap, page, 0, 0, w, h, 0, flags)
        }

        return try image(from: bitmap, width: pixelSize.width, height: pixelSize.height)
    }

    /// Renders in steps so a cancelled task stops promptly instead of finishing wastefully.
    private func renderProgressively(bitmap: FPDF_BITMAP,
                                     page: FPDF_PAGE,
                                     width: Int32,
                                     height: Int32,
                                     flags: Int32) throws {
        var pause = IFSDK_PAUSE()
        pause.version = 1
        pause.NeedToPauseNow = { _ in 1 }   // yield after each step so cancellation is observable

        var status = FPDF_RenderPageBitmap_Start(bitmap, page, 0, 0, width, height, 0, flags, &pause)
        while status == FPDF_RENDER_TOBECONTINUED {
            if Task.isCancelled {
                FPDF_RenderPage_Close(page)
                throw PdfError.cancelled
            }
            status = FPDF_RenderPage_Continue(page, &pause)
        }
        FPDF_RenderPage_Close(page)

        if status == FPDF_RENDER_FAILED {
            throw PdfError.corrupt(detail: "rendering page failed")
        }
    }

    private func image(from bitmap: FPDF_BITMAP, width: Int, height: Int) throws -> UIImage {
        guard let buffer = FPDFBitmap_GetBuffer(bitmap) else {
            throw PdfError.engine(code: -1)
        }
        let byteCount = width * height * 4
        let data = Data(bytes: buffer, count: byteCount)

        // PDFium's BGRA is little-endian 32-bit with alpha first.
        let info = CGBitmapInfo.byteOrder32Little
            .union(CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue))

        guard let provider = CGDataProvider(data: data as CFData),
              let cgImage = CGImage(width: width,
                                    height: height,
                                    bitsPerComponent: 8,
                                    bitsPerPixel: 32,
                                    bytesPerRow: width * 4,
                                    space: CGColorSpaceCreateDeviceRGB(),
                                    bitmapInfo: info,
                                    provider: provider,
                                    decode: nil,
                                    shouldInterpolate: true,
                                    intent: .defaultIntent)
        else {
            throw PdfError.engine(code: -1)
        }
        return UIImage(cgImage: cgImage)
    }
}
