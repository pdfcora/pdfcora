package com.pdfiumkit

/**
 * A document as it was when [PdfDocument.snapshot] was called.
 *
 * The bytes are never exposed: they are not watermarked, and handing them out would be a
 * way round the license. The reopened document needs the watermark if the original did.
 */
class PdfDocumentSnapshot internal constructor(
    private val bytes: ByteArray,
    private val needsWatermark: Boolean,
) {
    /** Opens a new document from the snapshot. Each call opens another. */
    suspend fun open(): PdfDocument = PdfDocument.open(bytes).also { if (needsWatermark) it.needsWatermark = true }
}

/**
 * A copy of the document as it is now, to reopen later — for undoing a change that cannot
 * be undone in place, such as a redaction.
 */
suspend fun PdfDocument.snapshot(): PdfDocumentSnapshot {
    val marked = needsWatermark
    val bytes = onDocument { Native.saveDocument(it, PdfSaveMode.FULL.flag) }
    if (bytes.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
    return PdfDocumentSnapshot(bytes, marked)
}
