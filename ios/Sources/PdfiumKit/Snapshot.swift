import Foundation
@_implementationOnly import CPdfium

/// A document as it was when ``PdfDocument/snapshot()`` was called.
///
/// The bytes are never exposed: they are not watermarked, and handing them out would be a
/// way round the license. The reopened document needs the watermark if the original did.
public final class PdfDocumentSnapshot: Sendable {
    private let bytes: Data
    private let needsWatermark: Bool

    init(bytes: Data, needsWatermark: Bool) {
        self.bytes = bytes
        self.needsWatermark = needsWatermark
    }

    /// Opens a new document from the snapshot. Each call opens another.
    public func open() async throws -> PdfDocument {
        let document = try await PdfDocument(data: bytes)
        if needsWatermark { await document.markNeedsWatermark() }
        return document
    }
}

extension PdfDocument {
    /// A copy of the document as it is now, to reopen later — for undoing a change that
    /// cannot be undone in place, such as a redaction.
    public func snapshot() throws -> PdfDocumentSnapshot {
        let handle = try requireHandle()
        if let form { FORM_ForceToKillFocus(form) }
        return PdfDocumentSnapshot(bytes: try Self.serialise(handle, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL)),
                                   needsWatermark: needsWatermark)
    }

    func markNeedsWatermark() { needsWatermark = true }
}
