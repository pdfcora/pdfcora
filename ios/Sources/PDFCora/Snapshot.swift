import Foundation
@_implementationOnly import CPdfium

/// A document as it was when ``PdfDocument/snapshot()`` was called.
public final class PdfDocumentSnapshot: Sendable {
    private let bytes: Data

    init(bytes: Data) {
        self.bytes = bytes
    }

    /// Opens a new document from the snapshot. Each call opens another.
    public func open() async throws -> PdfDocument {
        try await PdfDocument(data: bytes)
    }
}

extension PdfDocument {
    /// A copy of the document as it is now, to reopen later — for undoing a change that
    /// cannot be undone in place, such as a redaction.
    public func snapshot() throws -> PdfDocumentSnapshot {
        let handle = try requireHandle()
        if let form { FORM_ForceToKillFocus(form) }
        return PdfDocumentSnapshot(bytes: try Self.serialise(handle, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL)))
    }
}
