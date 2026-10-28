import Foundation
@_implementationOnly import CPdfium

/// Fields every annotation carries, whatever its type.
public struct PdfAnnotationBase: Equatable, Sendable {
    public let pageIndex: Int
    /// Position within the page's annotation list; used to address it for mutation.
    public let index: Int
    public let rect: PdfRect
    public let color: PdfColor?
    public let flags: PdfAnnotationFlags
    public let contents: String?
}

/// An annotation, as a snapshot.
///
/// Reading gives you values rather than live PDFium handles, so an annotation can be
/// held across tasks and can never dangle. Mutations go back through ``PdfPage``.
public enum PdfAnnotation: Equatable, Sendable {
    /// Text-markup annotations, which cover runs of text with quads.
    public struct Markup: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let quads: [PdfQuad]
    }
    public struct Ink: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let strokes: [[PdfPoint]]
    }
    public struct FreeText: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let fontSize: Double?
    }
    public struct Shape: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let interiorColor: PdfColor?
    }
    public struct Line: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let start: PdfPoint
        public let end: PdfPoint
    }
    public struct Note: Equatable, Sendable {
        public let base: PdfAnnotationBase
    }
    public struct LinkAnnotation: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let uri: String?
    }
    public struct Widget: Equatable, Sendable {
        public let base: PdfAnnotationBase
        public let fieldName: String?
    }
    public struct Other: Equatable, Sendable {
        public let base: PdfAnnotationBase
        /// The raw PDFium subtype, for annotations this SDK does not model.
        public let subtypeCode: Int
    }

    case highlight(Markup)
    case underline(Markup)
    case strikeout(Markup)
    case squiggly(Markup)
    case ink(Ink)
    case freeText(FreeText)
    case square(Shape)
    case circle(Shape)
    case line(Line)
    case text(Note)
    case link(LinkAnnotation)
    case stamp(Note)
    case fileAttachment(Note)
    case widget(Widget)
    /// A subtype this SDK does not model. Never dropped silently.
    case unknown(Other)

    public var base: PdfAnnotationBase {
        switch self {
        case .highlight(let a), .underline(let a), .strikeout(let a), .squiggly(let a): return a.base
        case .ink(let a): return a.base
        case .freeText(let a): return a.base
        case .square(let a), .circle(let a): return a.base
        case .line(let a): return a.base
        case .text(let a), .stamp(let a), .fileAttachment(let a): return a.base
        case .link(let a): return a.base
        case .widget(let a): return a.base
        case .unknown(let a): return a.base
        }
    }
}

extension PdfPage {
    /// All annotations on the page, in document order.
    public func annotations() async throws -> [PdfAnnotation] {
        try await document.annotations(pageIndex: index)
    }

    /// Adds a highlight covering `quads`.
    @discardableResult
    public func addHighlight(quads: [PdfQuad], color: PdfColor = .yellow) async throws -> Int {
        try await document.addMarkup(pageIndex: index, subtype: FPDF_ANNOT_HIGHLIGHT, quads: quads, color: color)
    }

    @discardableResult
    public func addUnderline(quads: [PdfQuad], color: PdfColor = PdfColor(red: 0, green: 0, blue: 255)) async throws -> Int {
        try await document.addMarkup(pageIndex: index, subtype: FPDF_ANNOT_UNDERLINE, quads: quads, color: color)
    }

    @discardableResult
    public func addStrikeout(quads: [PdfQuad], color: PdfColor = PdfColor(red: 255, green: 0, blue: 0)) async throws -> Int {
        try await document.addMarkup(pageIndex: index, subtype: FPDF_ANNOT_STRIKEOUT, quads: quads, color: color)
    }

    /// Adds a freehand ink annotation from one or more strokes.
    @discardableResult
    public func addInk(strokes: [[PdfPoint]], color: PdfColor = .black, lineWidth: Double = 2) async throws -> Int {
        try await document.addInk(pageIndex: index, strokes: strokes, color: color, lineWidth: lineWidth)
    }

    /// Adds a sticky note.
    @discardableResult
    public func addNote(rect: PdfRect, contents: String, color: PdfColor = .yellow) async throws -> Int {
        try await document.addNote(pageIndex: index, rect: rect, contents: contents, color: color)
    }

    public func removeAnnotation(at annotationIndex: Int) async throws {
        try await document.removeAnnotation(pageIndex: index, annotationIndex: annotationIndex)
    }
}

extension PdfDocument {
    func annotations(pageIndex: Int) throws -> [PdfAnnotation] {
        let page = try loadedPage(pageIndex)
        let count = Int(FPDFPage_GetAnnotCount(page))
        var result: [PdfAnnotation] = []
        result.reserveCapacity(max(0, count))

        for i in 0..<max(0, count) {
            guard let annot = FPDFPage_GetAnnot(page, Int32(i)) else { continue }
            defer { FPDFPage_CloseAnnot(annot) }
            result.append(snapshot(annot, pageIndex: pageIndex, index: i))
        }
        return result
    }

    private func snapshot(_ annot: FPDF_ANNOTATION, pageIndex: Int, index: Int) -> PdfAnnotation {
        var rect = FS_RECTF()
        FPDFAnnot_GetRect(annot, &rect)
        let base = PdfAnnotationBase(
            pageIndex: pageIndex,
            index: index,
            rect: PdfRect(left: Double(rect.left), bottom: Double(rect.bottom),
                          right: Double(rect.right), top: Double(rect.top)),
            color: annotColor(annot, type: FPDFANNOT_COLORTYPE_Color),
            flags: PdfAnnotationFlags(rawValue: Int(FPDFAnnot_GetFlags(annot))),
            contents: annotString(annot, key: "Contents")
        )

        let subtype = FPDFAnnot_GetSubtype(annot)
        switch subtype {
        case FPDF_ANNOT_HIGHLIGHT: return .highlight(.init(base: base, quads: quads(annot)))
        case FPDF_ANNOT_UNDERLINE: return .underline(.init(base: base, quads: quads(annot)))
        case FPDF_ANNOT_STRIKEOUT: return .strikeout(.init(base: base, quads: quads(annot)))
        case FPDF_ANNOT_SQUIGGLY:  return .squiggly(.init(base: base, quads: quads(annot)))
        case FPDF_ANNOT_INK:       return .ink(.init(base: base, strokes: inkStrokes(annot)))
        case FPDF_ANNOT_FREETEXT:
            var size: Float = 0
            let ok = FPDFAnnot_GetFontSize(form, annot, &size) != 0
            return .freeText(.init(base: base, fontSize: ok ? Double(size) : nil))
        case FPDF_ANNOT_SQUARE:
            return .square(.init(base: base, interiorColor: annotColor(annot, type: FPDFANNOT_COLORTYPE_InteriorColor)))
        case FPDF_ANNOT_CIRCLE:
            return .circle(.init(base: base, interiorColor: annotColor(annot, type: FPDFANNOT_COLORTYPE_InteriorColor)))
        case FPDF_ANNOT_LINE:
            var start = FS_POINTF(), end = FS_POINTF()
            if FPDFAnnot_GetLine(annot, &start, &end) != 0 {
                return .line(.init(base: base,
                                   start: PdfPoint(x: Double(start.x), y: Double(start.y)),
                                   end: PdfPoint(x: Double(end.x), y: Double(end.y))))
            }
            return .unknown(.init(base: base, subtypeCode: Int(subtype)))
        case FPDF_ANNOT_TEXT:           return .text(.init(base: base))
        case FPDF_ANNOT_STAMP:          return .stamp(.init(base: base))
        case FPDF_ANNOT_FILEATTACHMENT: return .fileAttachment(.init(base: base))
        case FPDF_ANNOT_LINK:
            return .link(.init(base: base, uri: annotString(annot, key: "A")))
        case FPDF_ANNOT_WIDGET:
            return .widget(.init(base: base, fieldName: form.flatMap { formFieldName(annot, form: $0) }))
        default:
            return .unknown(.init(base: base, subtypeCode: Int(subtype)))
        }
    }

    private func annotColor(_ annot: FPDF_ANNOTATION, type: FPDFANNOT_COLORTYPE) -> PdfColor? {
        var r: UInt32 = 0, g: UInt32 = 0, b: UInt32 = 0, a: UInt32 = 0
        guard FPDFAnnot_GetColor(annot, type, &r, &g, &b, &a) != 0 else { return nil }
        return PdfColor(red: UInt8(truncatingIfNeeded: r), green: UInt8(truncatingIfNeeded: g),
                        blue: UInt8(truncatingIfNeeded: b), alpha: UInt8(truncatingIfNeeded: a))
    }

    private func annotString(_ annot: FPDF_ANNOTATION, key: String) -> String? {
        let byteCount = FPDFAnnot_GetStringValue(annot, key, nil, 0)
        guard byteCount > 2 else { return nil }
        var buffer = [UInt16](repeating: 0, count: Int(byteCount) / 2)
        FPDFAnnot_GetStringValue(annot, key, &buffer, byteCount)
        let text = String(decoding: buffer.dropLast(), as: UTF16.self)
        return text.isEmpty ? nil : text
    }

    private func formFieldName(_ annot: FPDF_ANNOTATION, form: FPDF_FORMHANDLE) -> String? {
        let byteCount = FPDFAnnot_GetFormFieldName(form, annot, nil, 0)
        guard byteCount > 2 else { return nil }
        var buffer = [UInt16](repeating: 0, count: Int(byteCount) / 2)
        FPDFAnnot_GetFormFieldName(form, annot, &buffer, byteCount)
        let text = String(decoding: buffer.dropLast(), as: UTF16.self)
        return text.isEmpty ? nil : text
    }

    private func quads(_ annot: FPDF_ANNOTATION) -> [PdfQuad] {
        let count = Int(FPDFAnnot_CountAttachmentPoints(annot))
        var result: [PdfQuad] = []
        for i in 0..<max(0, count) {
            var q = FS_QUADPOINTSF()
            guard FPDFAnnot_GetAttachmentPoints(annot, size_t(i), &q) != 0 else { continue }
            result.append(PdfQuad(
                p1: PdfPoint(x: Double(q.x1), y: Double(q.y1)),
                p2: PdfPoint(x: Double(q.x2), y: Double(q.y2)),
                p3: PdfPoint(x: Double(q.x3), y: Double(q.y3)),
                p4: PdfPoint(x: Double(q.x4), y: Double(q.y4))))
        }
        return result
    }

    private func inkStrokes(_ annot: FPDF_ANNOTATION) -> [[PdfPoint]] {
        let pathCount = Int(FPDFAnnot_GetInkListCount(annot))
        var strokes: [[PdfPoint]] = []
        for p in 0..<max(0, pathCount) {
            let n = Int(FPDFAnnot_GetInkListPath(annot, UInt(p), nil, 0))
            guard n > 0 else { continue }
            var points = [FS_POINTF](repeating: FS_POINTF(), count: n)
            let written = Int(FPDFAnnot_GetInkListPath(annot, UInt(p), &points, UInt(n)))
            strokes.append(points.prefix(written).map { PdfPoint(x: Double($0.x), y: Double($0.y)) })
        }
        return strokes
    }

    // MARK: - Mutation

    func addMarkup(pageIndex: Int, subtype: FPDF_ANNOTATION_SUBTYPE, quads: [PdfQuad], color: PdfColor) throws -> Int {
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_CreateAnnot(page, subtype) else {
            throw PdfError.engine(code: -1)
        }
        defer { FPDFPage_CloseAnnot(annot) }

        for q in quads {
            var quad = FS_QUADPOINTSF(x1: Float(q.p1.x), y1: Float(q.p1.y),
                                      x2: Float(q.p2.x), y2: Float(q.p2.y),
                                      x3: Float(q.p3.x), y3: Float(q.p3.y),
                                      x4: Float(q.p4.x), y4: Float(q.p4.y))
            FPDFAnnot_AppendAttachmentPoints(annot, &quad)
        }
        if let bounds = boundingRect(of: quads) {
            var rect = FS_RECTF(left: Float(bounds.left), top: Float(bounds.top),
                                right: Float(bounds.right), bottom: Float(bounds.bottom))
            FPDFAnnot_SetRect(annot, &rect)
        }
        FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color,
                           UInt32(color.red), UInt32(color.green), UInt32(color.blue), UInt32(color.alpha))
        FPDFPage_GenerateContent(page)
        return Int(FPDFPage_GetAnnotCount(page)) - 1
    }

    func addInk(pageIndex: Int, strokes: [[PdfPoint]], color: PdfColor, lineWidth: Double) throws -> Int {
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_INK) else {
            throw PdfError.engine(code: -1)
        }
        defer { FPDFPage_CloseAnnot(annot) }

        for stroke in strokes where !stroke.isEmpty {
            var points = stroke.map { FS_POINTF(x: Float($0.x), y: Float($0.y)) }
            _ = FPDFAnnot_AddInkStroke(annot, &points, size_t(points.count))
        }
        FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color,
                           UInt32(color.red), UInt32(color.green), UInt32(color.blue), UInt32(color.alpha))
        FPDFAnnot_SetBorder(annot, 0, 0, Float(lineWidth))

        let all = strokes.flatMap { $0 }
        if let bounds = boundingRect(ofPoints: all) {
            var rect = FS_RECTF(left: Float(bounds.left), top: Float(bounds.top),
                                right: Float(bounds.right), bottom: Float(bounds.bottom))
            FPDFAnnot_SetRect(annot, &rect)
        }
        FPDFPage_GenerateContent(page)
        return Int(FPDFPage_GetAnnotCount(page)) - 1
    }

    func addNote(pageIndex: Int, rect: PdfRect, contents: String, color: PdfColor) throws -> Int {
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_CreateAnnot(page, FPDF_ANNOT_TEXT) else {
            throw PdfError.engine(code: -1)
        }
        defer { FPDFPage_CloseAnnot(annot) }

        var r = FS_RECTF(left: Float(rect.left), top: Float(rect.top),
                         right: Float(rect.right), bottom: Float(rect.bottom))
        FPDFAnnot_SetRect(annot, &r)
        var text = Array(contents.utf16) + [0]
        FPDFAnnot_SetStringValue(annot, "Contents", &text)
        FPDFAnnot_SetColor(annot, FPDFANNOT_COLORTYPE_Color,
                           UInt32(color.red), UInt32(color.green), UInt32(color.blue), UInt32(color.alpha))
        FPDFPage_GenerateContent(page)
        return Int(FPDFPage_GetAnnotCount(page)) - 1
    }

    func removeAnnotation(pageIndex: Int, annotationIndex: Int) throws {
        let page = try loadedPage(pageIndex)
        let count = Int(FPDFPage_GetAnnotCount(page))
        guard annotationIndex >= 0 && annotationIndex < count else {
            throw PdfError.pageOutOfRange(annotationIndex, count: count)
        }
        FPDFPage_RemoveAnnot(page, Int32(annotationIndex))
        FPDFPage_GenerateContent(page)
    }

    private func boundingRect(of quads: [PdfQuad]) -> PdfRect? {
        boundingRect(ofPoints: quads.flatMap { [$0.p1, $0.p2, $0.p3, $0.p4] })
    }

    private func boundingRect(ofPoints points: [PdfPoint]) -> PdfRect? {
        guard let first = points.first else { return nil }
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for p in points.dropFirst() {
            minX = min(minX, p.x); maxX = max(maxX, p.x)
            minY = min(minY, p.y); maxY = max(maxY, p.y)
        }
        return PdfRect(left: minX, bottom: minY, right: maxX, top: maxY)
    }
}
