import Foundation
@_implementationOnly import CPdfium

/// Removing content from a page, and from everything attached to it.
///
/// Drawing a black rectangle over text is the classic redaction failure: it looks right
/// and every word is still in the file. These remove the objects themselves.
extension Redactor {

    /// Removes every object a region touches and regenerates the content stream.
    static func redact(
        document: FPDF_DOCUMENT,
        page: FPDF_PAGE,
        textPage: FPDF_TEXTPAGE?,
        regions: [PdfRect],
        counts: inout Counts
    ) -> Bool {
        guard !regions.isEmpty else { return false }

        // Partially covered runs first: they are rewritten rather than removed, and
        // doing it before the whole-object pass keeps the two from fighting over the
        // same handles.
        let (split, handled) = splitPartiallyCovered(
            document: document, page: page, textPage: textPage, regions: regions)
        counts.textObjectsSplit += split

        let doomed = objects(page: page, textPage: textPage)
            .filter { object in regions.contains { intersects(object.bounds, $0) } }
        guard !doomed.isEmpty || split > 0 else { return false }

        // Highest index first: removing one shifts every index above it, and walking
        // upward would silently skip objects.
        for object in doomed.sorted(by: { $0.index > $1.index }) {
            guard let handle = FPDFPage_GetObject(page, Int32(object.index)),
                  !handled.contains(handle) else { continue }
            guard FPDFPage_RemoveObject(page, handle) != 0 else { continue }

            // RemoveObject detaches but does not free.
            FPDFPageObj_Destroy(handle)
            switch object.kind {
            case .text: counts.textObjects += 1
            case .image: counts.images += 1
            default: counts.paths += 1
            }
        }

        _ = FPDFPage_GenerateContent(page)
        return true
    }

    /// Rewrites the text objects a region only partially covers.
    ///
    /// Characters are dropped on intersection, not containment: a character half inside
    /// the region is still legible and still in the text layer.
    private static func splitPartiallyCovered(
        document: FPDF_DOCUMENT,
        page: FPDF_PAGE,
        textPage: FPDF_TEXTPAGE?,
        regions: [PdfRect]
    ) -> (split: Int, handled: Set<FPDF_PAGEOBJECT>) {
        guard let textPage else { return (0, []) }

        var handled = Set<FPDF_PAGEOBJECT>()
        var split = 0

        for (handle, indices) in charactersByObject(textPage) {
            let boxes = indices.map { (index: $0, box: charBox(textPage, $0)) }
            let covered = boxes.filter { pair in regions.contains { intersects(pair.box, $0) } }

            // Untouched, or covered outright: neither is this path's business.
            if covered.isEmpty || covered.count == boxes.count { continue }

            let removed = Set(covered.map(\.index))
            let runs = survivingRuns(textPage, boxes, removed)
            guard replace(document: document, page: page, handle: handle, runs: runs) else { continue }

            handled.insert(handle)
            split += 1
        }
        return (split, handled)
    }

    /// A text object holds glyph codes, not characters; the text page is the only thing
    /// that knows what they say and where they sit.
    private static func charactersByObject(_ textPage: FPDF_TEXTPAGE) -> [FPDF_PAGEOBJECT: [Int]] {
        var byObject: [FPDF_PAGEOBJECT: [Int]] = [:]
        for index in 0..<Int(FPDFText_CountChars(textPage)) {
            guard let handle = FPDFText_GetTextObject(textPage, Int32(index)) else { continue }
            byObject[handle, default: []].append(index)
        }
        return byObject
    }

    private static func charBox(_ textPage: FPDF_TEXTPAGE, _ index: Int) -> PdfRect {
        var left = 0.0, right = 0.0, bottom = 0.0, top = 0.0
        // The out-parameters are left, right, bottom, top — not the usual rect order.
        FPDFText_GetCharBox(textPage, Int32(index), &left, &right, &bottom, &top)
        return PdfRect(
            left: min(left, right), bottom: min(bottom, top),
            right: max(left, right), top: max(bottom, top))
    }

    private struct Run { let text: String; let left: Double; let bottom: Double }

    private static func survivingRuns(
        _ textPage: FPDF_TEXTPAGE,
        _ boxes: [(index: Int, box: PdfRect)],
        _ removed: Set<Int>
    ) -> [Run] {
        var runs: [Run] = []
        var current: (text: String, left: Double, bottom: Double)?

        for (index, box) in boxes {
            if removed.contains(index) {
                if let run = current { runs.append(Run(text: run.text, left: run.left, bottom: run.bottom)) }
                current = nil
                continue
            }
            let scalar = UnicodeScalar(FPDFText_GetUnicode(textPage, Int32(index))) ?? " "
            if current != nil {
                current!.text.append(Character(scalar))
            } else {
                current = (String(Character(scalar)), box.left, box.bottom)
            }
        }
        if let run = current { runs.append(Run(text: run.text, left: run.left, bottom: run.bottom)) }
        return runs
    }

    /// The original is removed and each run drawn as its own object rather than edited in
    /// place: `FPDFText_SetText` keeps the object's matrix, so a run that no longer starts
    /// where the object did would render in the wrong place.
    private static func replace(
        document: FPDF_DOCUMENT, page: FPDF_PAGE, handle: FPDF_PAGEOBJECT, runs: [Run]
    ) -> Bool {
        guard let font = FPDFTextObj_GetFont(handle) else { return false }
        var size: Float = 0
        guard FPDFTextObj_GetFontSize(handle, &size) != 0 else { return false }

        var created: [FPDF_PAGEOBJECT] = []
        for run in runs {
            guard let object = FPDFPageObj_CreateTextObj(document, font, size) else { return false }

            var units = Array(run.text.utf16) + [0]
            let ok = units.withUnsafeMutableBufferPointer {
                FPDFText_SetText(object, $0.baseAddress)
            }
            guard ok != 0 else { FPDFPageObj_Destroy(object); return false }

            // An identity matrix translated to the run's origin, so the glyphs land
            // where they were.
            var matrix = FS_MATRIX(a: 1, b: 0, c: 0, d: 1,
                                   e: Float(run.left), f: Float(run.bottom))
            FPDFPageObj_SetMatrix(object, &matrix)
            created.append(object)
        }

        // Only now that every run is built is the original removed, so a failure
        // part-way through leaves the page as it was rather than half-redacted.
        guard FPDFPage_RemoveObject(page, handle) != 0 else {
            created.forEach { FPDFPageObj_Destroy($0) }
            return false
        }
        FPDFPageObj_Destroy(handle)
        created.forEach { FPDFPage_InsertObject(page, $0) }
        return true
    }

    // MARK: - Beyond page content

    /// A comment over redacted text survives unless it is removed explicitly.
    static func scrubAnnotations(page: FPDF_PAGE, regions: [PdfRect], counts: inout Counts) {
        let count = Int(FPDFPage_GetAnnotCount(page))
        guard count > 0 else { return }

        var doomed: [Int] = []
        for index in 0..<count {
            guard let annotation = FPDFPage_GetAnnot(page, Int32(index)) else { continue }
            defer { FPDFPage_CloseAnnot(annotation) }

            var rect = FS_RECTF()
            guard FPDFAnnot_GetRect(annotation, &rect) != 0 else { continue }
            let bounds = PdfRect(
                left: Double(min(rect.left, rect.right)), bottom: Double(min(rect.bottom, rect.top)),
                right: Double(max(rect.left, rect.right)), top: Double(max(rect.bottom, rect.top)))
            guard regions.contains(where: { intersects(bounds, $0) }) else { continue }

            // A form field's value lives in the AcroForm field dictionary, not on the
            // page, so removing the widget alone leaves the value in the file.
            clearFieldValue(annotation, counts: &counts)
            doomed.append(index)
        }

        for index in doomed.reversed() where FPDFPage_RemoveAnnot(page, Int32(index)) != 0 {
            counts.annotations += 1
        }
    }

    private static func clearFieldValue(_ annotation: FPDF_ANNOTATION, counts: inout Counts) {
        var empty: [UInt16] = [0]
        let cleared = empty.withUnsafeMutableBufferPointer {
            FPDFAnnot_SetStringValue(annotation, "V", $0.baseAddress)
        }
        guard cleared != 0 else { return }
        counts.formFields.append(stringValue(annotation, "T") ?? "(unnamed)")
    }

    private static func stringValue(_ annotation: FPDF_ANNOTATION, _ key: String) -> String? {
        let size = FPDFAnnot_GetStringValue(annotation, key, nil, 0)
        guard size > 2 else { return nil }

        var units = [UInt16](repeating: 0, count: Int(size) / 2)
        _ = units.withUnsafeMutableBufferPointer {
            FPDFAnnot_GetStringValue(annotation, key, $0.baseAddress, size)
        }
        if units.last == 0 { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    /// An attachment is the easiest way for removed text to walk out of a document.
    static func scrubAttachments(document: FPDF_DOCUMENT, needles: [String], counts: inout Counts) {
        let count = Int(FPDFDoc_GetAttachmentCount(document))
        var doomed: [(index: Int, name: String)] = []

        for index in 0..<count {
            guard let attachment = FPDFDoc_GetAttachment(document, Int32(index)) else { continue }
            let name = attachmentName(attachment)
            let content = attachmentContent(attachment)
            if needles.contains(where: { name.contains($0) || content.contains($0) }) {
                doomed.append((index, name))
            }
        }

        for (index, name) in doomed.reversed()
        where FPDFDoc_DeleteAttachment(document, Int32(index)) != 0 {
            counts.attachments.append(name)
        }
    }

    private static func attachmentName(_ attachment: FPDF_ATTACHMENT) -> String {
        let size = FPDFAttachment_GetName(attachment, nil, 0)
        guard size > 2 else { return "" }

        var units = [UInt16](repeating: 0, count: Int(size) / 2)
        _ = units.withUnsafeMutableBufferPointer {
            FPDFAttachment_GetName(attachment, $0.baseAddress, size)
        }
        if units.last == 0 { units.removeLast() }
        return String(decoding: units, as: UTF16.self)
    }

    /// Read as latin-1: the point is to find a string in it, not to interpret it.
    private static func attachmentContent(_ attachment: FPDF_ATTACHMENT) -> String {
        var size: UInt = 0
        FPDFAttachment_GetFile(attachment, nil, 0, &size)
        guard size > 0 else { return "" }

        var bytes = [UInt8](repeating: 0, count: Int(size))
        _ = bytes.withUnsafeMutableBufferPointer {
            FPDFAttachment_GetFile(attachment, $0.baseAddress, size, &size)
        }
        return String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) }))
    }
}
