package com.pdfiumkit

import java.util.Calendar
import java.util.Date
import java.util.TimeZone

/** A signature already present in a document. Reading only; nothing here is verified. */
data class PdfSignature(
    val index: Int,
    val reason: String?,
    /** The time the signer claimed. Not trusted, and not a timestamp authority's. */
    val signingTime: Date?,
    /** e.g. `adbe.pkcs7.detached`, `ETSI.CAdES.detached`. */
    val subFilter: String?,
    /** Pairs of offset and length covering the signed spans of the file. */
    val byteRange: List<Int>,
    /** The raw PKCS#7 blob, for a verifier to check. */
    val contents: ByteArray,
    val docMdpPermission: Int?,
    /**
     * Whether the signed ranges reach the end of the file.
     *
     * A signature can be cryptographically valid and still cover only part of the
     * document; anything appended afterwards is unprotected.
     */
    val coversWholeDocument: Boolean,
) {
    override fun equals(other: Any?): Boolean =
        other is PdfSignature &&
            index == other.index &&
            reason == other.reason &&
            signingTime == other.signingTime &&
            subFilter == other.subFilter &&
            byteRange == other.byteRange &&
            contents.contentEquals(other.contents) &&
            docMdpPermission == other.docMdpPermission &&
            coversWholeDocument == other.coversWholeDocument

    override fun hashCode(): Int = index * 31 + contents.contentHashCode()
}

/**
 * Signatures already present in the document. Reading only; nothing is verified.
 *
 * PDFium exposes no way to create a signature and no crypto at all, so [contents] is
 * handed back as the raw PKCS#7 blob for a verifier to check.
 */
suspend fun PdfDocument.signatures(): List<PdfSignature> = onDocument { handle ->
    val count = Native.signatureCount(handle)
    if (count <= 0) return@onDocument emptyList()

    val fileLength = Native.documentByteLength(handle)
    (0 until count).map { index ->
        val byteRange = Native.signatureByteRange(handle, index).toList()
        PdfSignature(
            index = index,
            reason = Native.signatureReason(handle, index).ifEmpty { null },
            signingTime = parsePdfDate(Native.signatureAscii(handle, index, ASCII_TIME)),
            subFilter = Native.signatureAscii(handle, index, ASCII_SUB_FILTER).ifEmpty { null },
            byteRange = byteRange,
            contents = Native.signatureContents(handle, index),
            docMdpPermission = Native.signatureDocMdp(handle, index).takeIf { it > 0 },
            coversWholeDocument = coversWholeDocument(byteRange, fileLength),
        )
    }
}

private const val ASCII_SUB_FILTER = 0
private const val ASCII_TIME = 1

/**
 * Computed, not read. Treating "has a valid signature" as "is unmodified" is how a
 * signed document gets silently amended.
 */
private fun coversWholeDocument(byteRange: List<Int>, fileLength: Long): Boolean {
    if (byteRange.size < 2) return false
    val start = byteRange[byteRange.size - 2].toLong()
    val length = byteRange[byteRange.size - 1].toLong()
    return start + length == fileLength
}

/**
 * Parses a PDF date: `D:YYYYMMDDHHmmSS` with an optional `OHH'mm'` offset, where O is
 * Z, + or -. Signature times carry one and are compared against real instants, so
 * ignoring it shifts the reported day.
 */
internal fun parsePdfDate(raw: String): Date? {
    val text = raw.trim().removePrefix("D:")
    val digits = text.takeWhile { it.isDigit() }
    if (digits.length < 8) return null

    fun part(start: Int, length: Int): Int? =
        if (digits.length >= start + length) digits.substring(start, start + length).toIntOrNull() else null

    val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
        clear()
        set(
            part(0, 4) ?: return null,
            (part(4, 2) ?: 1) - 1,
            part(6, 2) ?: 1,
            part(8, 2) ?: 0,
            part(10, 2) ?: 0,
            part(12, 2) ?: 0,
        )
    }

    val suffix = text.drop(digits.length)
    val sign = suffix.firstOrNull()
    if (sign == '+' || sign == '-') {
        val offsetDigits = suffix.drop(1).filter { it.isDigit() }
        val hours = offsetDigits.take(2).toIntOrNull() ?: 0
        val minutes = offsetDigits.drop(2).take(2).toIntOrNull() ?: 0
        val seconds = hours * 3600 + minutes * 60
        calendar.add(Calendar.SECOND, if (sign == '+') -seconds else seconds)
    }
    return calendar.time
}
