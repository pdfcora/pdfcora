package com.pdfiumkit.view

import com.pdfiumkit.PdfPageRotation
import com.pdfiumkit.PdfPoint
import com.pdfiumkit.PdfRect
import com.pdfiumkit.PdfSize
import com.pdfiumkit.PdfViewTransform

/** A window, in view pixels. Deliberately not android.util.Size: this is pure logic and
 *  must be unit-testable off-device. */
data class PdfViewport(val width: Float, val height: Float)

/** A scroll position, in view pixels. */
data class PdfViewOffset(val x: Float, val y: Float)

enum class PdfPageLayout { SINGLE, CONTINUOUS;
    val wire: String get() = name.lowercase()
    companion object { fun fromWire(w: String) = entries.firstOrNull { it.wire == w } }
}

/** What a drag on the page does. Lives in the SDK so peers can agree on it. */
enum class PdfTool { SELECT, INK, NOTE, HIGHLIGHT, REDACT;
    val wire: String get() = name.lowercase()
    companion object { fun fromWire(w: String) = entries.firstOrNull { it.wire == w } }
}

/** What the user has picked out: a dragged area, or an existing annotation. */
sealed class PdfSelection {
    data class Region(val page: Int, val rect: PdfRect) : PdfSelection()
    data class Annotation(val page: Int, val index: Int) : PdfSelection()
}

/**
 * Where a viewer is looking, in a form that survives a change of screen.
 *
 * Held in document space rather than view space: a scroll offset is in the sending
 * viewer's own pixels and means nothing elsewhere, so what travels is the page and the
 * PDF point at the centre of the viewport.
 */
data class PdfViewState(
    val pageIndex: Int,
    /** In PDF coordinates on [pageIndex]: the point at the centre of the viewport. */
    val center: PdfPoint,
    val zoom: PdfZoom,
    val rotation: PdfPageRotation,
    val layout: PdfPageLayout,
)

sealed class PdfViewChange {
    data class Viewport(val state: PdfViewState) : PdfViewChange()
    data class Selection(val selection: PdfSelection?) : PdfViewChange()
    data class Tool(val tool: PdfTool) : PdfViewChange()
    // An Edit change arrives with the editing phase, in its own plan.
}

enum class PdfViewEventOrigin { LOCAL, REMOTE;
    val wire: String get() = name.lowercase()
    companion object { fun fromWire(w: String) = entries.firstOrNull { it.wire == w } }
}

data class PdfViewEvent(
    /** Per sender. A peer ignores anything at or below the highest it has seen. */
    val sequence: Int,
    val sessionId: String,
    /** Applying a remote event must emit nothing, or two viewers echo each other. */
    val origin: PdfViewEventOrigin,
    val change: PdfViewChange,
)

/**
 * The PDF point currently at the centre of the viewport.
 *
 * This is the transferable form of a scroll position: an offset is in this viewer's own
 * pixels, relative to its own content size, and means nothing on another screen.
 *
 * An extension rather than a member so it stays free of android.graphics types and can
 * be unit-tested without a device.
 */
fun PdfViewTransform.centerForScrollOffset(offset: PdfViewOffset, viewport: PdfViewport): PdfPoint =
    PdfPoint(
        (offset.x + viewport.width / 2f) / scale,
        pageSize.height - (offset.y + viewport.height / 2f) / scale,
    )

/**
 * Where to scroll so [center] sits in the middle of the viewport.
 *
 * Clamped to the scrollable range, so a centre near a page edge gives a valid offset on
 * a differently shaped screen rather than one outside the content. A viewport larger
 * than the page scrolls to zero and the app centres it.
 */
fun PdfViewTransform.scrollOffsetCentering(center: PdfPoint, viewport: PdfViewport): PdfViewOffset {
    val viewX = center.x * scale
    val viewY = (pageSize.height - center.y) * scale
    fun clamp(value: Float, maximum: Float) = maxOf(0f, minOf(value, maxOf(0f, maximum)))
    return PdfViewOffset(
        clamp(viewX - viewport.width / 2f, viewWidth - viewport.width),
        clamp(viewY - viewport.height / 2f, viewHeight - viewport.height),
    )
}

/**
 * Which page the centre falls on, walking the stack of page heights.
 *
 * [gap] is the spacing the app draws between pages. It counts: ignoring it is two pages
 * out by page twenty of a fifty-page document.
 */
fun pdfCurrentPage(heights: List<Float>, centerY: Float, gap: Float): Int {
    var bottom = 0f
    heights.forEachIndexed { index, height ->
        bottom += height + gap
        if (centerY < bottom) return index
    }
    // Past the end: the last page, rather than an index nobody can use.
    return maxOf(0, heights.size - 1)
}
