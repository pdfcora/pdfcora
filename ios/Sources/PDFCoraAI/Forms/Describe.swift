import Foundation
import PDFCora

struct PdfFieldDescription: Sendable {
    let pageIndex: Int
    let field: PdfFormField
    /// Page text next to the field (FORM-1).
    let label: String?
    var base: PdfFormFieldBase { field.base }
}

enum FieldDescriber {
    /// Every form field on the pages in scope, with the label printed next to it.
    static func describe(_ document: PdfDocument, pages: ClosedRange<Int>?) async throws -> [PdfFieldDescription] {
        let count = await document.pageCount
        guard count > 0 else { return [] }
        let range = max(0, pages?.lowerBound ?? 0)...min(count - 1, pages?.upperBound ?? count - 1)
        var described: [PdfFieldDescription] = []
        for pageIndex in range {
            let page = try await document.page(pageIndex)
            let fields = try await page.formFields()
            if fields.isEmpty { continue }
            let text = try await page.text.string()
            var boxes: [PdfRect?] = []
            for i in 0..<NSString(string: text).length {
                let box = try await page.text.boundingBox(ofCharacterAt: i)
                boxes.append(box.right > box.left && box.top > box.bottom ? box : nil)
            }
            for field in fields {
                described.append(PdfFieldDescription(pageIndex: pageIndex, field: field,
                    label: label(for: field.base.rect, others: fields.map(\.base.rect), text: text, boxes: boxes)))
            }
        }
        return described
    }

    /// Spec §4: text on the field's line to its left, else just above it.
    static func label(for rect: PdfRect, others: [PdfRect], text: String, boxes: [PdfRect?]) -> String? {
        let low = min(rect.bottom, rect.top), high = max(rect.bottom, rect.top)
        let left = min(rect.left, rect.right), right = max(rect.left, rect.right)
        let bound = ([left - 250] + others.filter { o in
            o != rect && max(o.left, o.right) <= left && min(o.bottom, o.top) < high && low < max(o.bottom, o.top)
        }.map { max($0.left, $0.right) }).max()!
        let onLine = { (b: PdfRect) -> Bool in
            let centre = (b.top + b.bottom) / 2
            return centre >= low - 2 && centre <= high + 2 && b.right <= left + 1 && b.left >= bound
        }
        let above = { (b: PdfRect) -> Bool in b.bottom >= high && b.bottom - high <= 14 && b.right > left && b.left < right }
        let units = NSString(string: text)
        for accept in [onLine, above] {
            let hits = boxes.indices.filter { boxes[$0].map(accept) ?? false }
            guard let first = hits.first, let last = hits.last else { continue }
            let label = units.substring(with: NSRange(location: first, length: last - first + 1))
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: #"[:\s]+$"#, with: "", options: .regularExpression)
            if !label.isEmpty { return label }
        }
        return nil
    }
}
