import Foundation
@_implementationOnly import CPdfium

/// A form field to create, for ``PdfDocument/addFormFields(_:)``.
public struct PdfNewFormField: Sendable, Equatable {
    public enum Kind: String, Sendable { case text, checkBox }

    public let pageIndex: Int
    public let kind: Kind
    public let rect: PdfRect
    /// The field name (`/T`); must be unique in the document.
    public let name: String
    /// Shown to users and screen readers (`/TU`).
    public let tooltip: String?

    public init(pageIndex: Int, kind: Kind, rect: PdfRect, name: String, tooltip: String? = nil) {
        self.pageIndex = pageIndex
        self.kind = kind
        self.rect = rect
        self.name = name
        self.tooltip = tooltip
    }
}

extension PdfDocument {
    /// Creates text fields and checkboxes, returning a new document; this document is unchanged.
    /// Throws ``PdfError/invalidOperation(reason:)``, writing nothing, when a name is empty or already
    /// used. Appended as an incremental update.
    public func addFormFields(_ fields: [PdfNewFormField]) async throws -> PdfDocument {
        use(.forms)
        let handle = try requireHandle()
        let pageCount = Int(FPDF_GetPageCount(handle))
        var names = Set<String>()
        for pageIndex in 0..<pageCount {
            for field in try formFields(pageIndex: pageIndex) { if let name = field.base.name { names.insert(name) } }
        }
        for field in fields {
            guard field.pageIndex >= 0, field.pageIndex < pageCount else { throw PdfError.pageOutOfRange(field.pageIndex, count: pageCount) }
            guard !field.name.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw PdfError.invalidOperation(reason: "a form field needs a name")
            }
            guard names.insert(field.name).inserted else {
                throw PdfError.invalidOperation(reason: "a field named \"\(field.name)\" already exists")
            }
        }
        if let form { FORM_ForceToKillFocus(form) }
        let base = try Self.serialise(handle, flags: FPDF_DWORD(FPDF_INCREMENTAL))
        let updated = try await PdfDocument(data: try FormFieldWriter.write(base, fields))
        if needsWatermark { await updated.markNeedsWatermark() }
        return updated
    }
}
