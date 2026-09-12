package com.pdfiumkit

import android.graphics.Color

/// A point in PDF page space: origin bottom-left, units are points.
data class PdfPoint(val x: Float, val y: Float)

/// A rectangle in PDF page space. Converting to view space is always explicit.
data class PdfRect(val left: Float, val bottom: Float, val right: Float, val top: Float) {
    val width: Float get() = right - left
    val height: Float get() = top - bottom

    /// Converts to top-left-origin view coordinates.
    fun toViewRect(pageHeight: Float, scale: Float = 1f): android.graphics.RectF =
        android.graphics.RectF(
            left * scale,
            (pageHeight - top) * scale,
            right * scale,
            (pageHeight - bottom) * scale
        )
}

data class PdfQuad(val p1: PdfPoint, val p2: PdfPoint, val p3: PdfPoint, val p4: PdfPoint)

data class PdfSize(val width: Float, val height: Float)

/// An RGBA colour.
data class PdfColor(val red: Int, val green: Int, val blue: Int, val alpha: Int = 255) {
    @androidx.annotation.ColorInt
    fun toColorInt(): Int = Color.argb(alpha, red, green, blue)

    companion object {
        val BLACK = PdfColor(0, 0, 0)
        val YELLOW = PdfColor(255, 255, 0, 128)

        fun fromColorInt(@androidx.annotation.ColorInt value: Int) =
            PdfColor(Color.red(value), Color.green(value), Color.blue(value), Color.alpha(value))
    }
}

enum class PdfPageRotation(val raw: Int) {
    NONE(0), DEGREES_90(1), DEGREES_180(2), DEGREES_270(3);

    companion object {
        fun fromRaw(raw: Int) = entries.firstOrNull { it.raw == raw } ?: NONE
    }
}

/// What to include when rendering.
data class PdfRenderOptions(
    val annotations: Boolean = true,
    val forms: Boolean = true,
    val grayscale: Boolean = false,
) {
    internal fun toFlags(): Int {
        var flags = 0
        if (annotations) flags = flags or 0x01   // FPDF_ANNOT
        if (grayscale) flags = flags or 0x08     // FPDF_GRAYSCALE
        return flags
    }

    companion object { val DEFAULT = PdfRenderOptions() }
}

data class PdfSearchOptions(val caseSensitive: Boolean = false, val wholeWord: Boolean = false) {
    internal fun toFlags(): Int {
        var flags = 0
        if (caseSensitive) flags = flags or 0x01
        if (wholeWord) flags = flags or 0x02
        return flags
    }

    companion object { val NONE = PdfSearchOptions() }
}

/// Permissions granted by the document's security handler.
@JvmInline
value class PdfPermissions(val raw: Int) {
    val canPrint: Boolean get() = raw and (1 shl 2) != 0
    val canModify: Boolean get() = raw and (1 shl 3) != 0
    val canCopy: Boolean get() = raw and (1 shl 4) != 0
    val canAnnotate: Boolean get() = raw and (1 shl 5) != 0
    val canFillForms: Boolean get() = raw and (1 shl 8) != 0
}

/// Typed document metadata.
data class PdfMetadata(
    val title: String? = null,
    val author: String? = null,
    val subject: String? = null,
    val keywords: String? = null,
    val creator: String? = null,
    val producer: String? = null,
)

data class PdfTextMatch(val start: Int, val length: Int, val rects: List<PdfRect>)

data class PdfAttachment(val name: String)

/// How to write the document out.
enum class PdfSaveMode(internal val flag: Int) {
    /// Rewrite the whole file. The default, and the only mode that reliably persists
    /// newly created annotations.
    FULL(2),

    /// Append changes. Verified against PDFium chromium/7243, annotations created in this
    /// session are NOT written in this mode — only edits to pre-existing objects.
    INCREMENTAL(1),
}

/** A bookmark in the document outline. The whole tree is read eagerly as values. */
data class PdfOutlineItem(
    val title: String,
    val pageIndex: Int?,
    val children: List<PdfOutlineItem>,
)
