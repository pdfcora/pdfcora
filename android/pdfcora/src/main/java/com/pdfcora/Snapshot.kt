package com.pdfcora

/** A document as it was when [PdfDocument.snapshot] was called. */
class PdfDocumentSnapshot internal constructor(
    private val bytes: ByteArray,
) {
    /** Opens a new document from the snapshot. Each call opens another. */
    suspend fun open(): PdfDocument = PdfDocument.open(bytes)
}

/**
 * A copy of the document as it is now, to reopen later — for undoing a change that cannot
 * be undone in place, such as a redaction.
 */
suspend fun PdfDocument.snapshot(): PdfDocumentSnapshot {
    val bytes = onDocument { Native.saveDocument(it, PdfSaveMode.FULL.flag) }
    if (bytes.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
    return PdfDocumentSnapshot(bytes)
}
