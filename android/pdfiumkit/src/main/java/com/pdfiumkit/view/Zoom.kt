package com.pdfiumkit.view

import com.pdfiumkit.PdfSize

enum class PdfZoomMode { FIT_WIDTH, FIT_PAGE, FREE;

    /** The spelling used on the wire, shared with the iOS and web SDKs. */
    val wire: String get() = when (this) {
        FIT_WIDTH -> "fitWidth"
        FIT_PAGE -> "fitPage"
        FREE -> "free"
    }

    companion object {
        fun fromWire(wire: String): PdfZoomMode? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * How magnified the page is, and how that was arrived at.
 *
 * A type rather than a number because three consumers need different things from it:
 * rendering needs the absolute [scale], sync needs the [mode] — a peer receiving
 * [PdfZoomMode.FIT_WIDTH] fits *its own* window, while [PdfZoomMode.FREE] it adopts
 * literally — and a toolbar needs a percentage, which is derived rather than stored so
 * it cannot go stale when the window resizes.
 */
data class PdfZoom(
    /** View pixels per PDF point. 1.0 is 1:1. */
    val scale: Float,
    val mode: PdfZoomMode,
) {
    /** 1:1 based, as Acrobat and Preview mean it. A phone's normal view reads about 64%. */
    val percentage: Int get() = Math.round(scale * 100f)

    /** Fit based, as most viewers mean it: 100% is whatever fills the window. */
    fun percentageOfFit(fitScale: Float): Int =
        if (fitScale > 0f) Math.round(scale / fitScale * 100f) else 100

    /**
     * Moves one rung along the ladder.
     *
     * A fit scale is almost never exactly on a rung, so stepping goes to the first rung
     * strictly beyond the current scale. The result is always [PdfZoomMode.FREE]: the
     * user picked this number, so a peer adopts it rather than re-deriving its own fit.
     */
    fun stepped(direction: Int): PdfZoom {
        val next = if (direction > 0) {
            steps.firstOrNull { it > scale + 1e-6f } ?: steps.last()
        } else {
            steps.lastOrNull { it < scale - 1e-6f } ?: steps.first()
        }
        return PdfZoom(next, PdfZoomMode.FREE)
    }

    companion object {
        val steps: List<Float> = listOf(0.25f, 0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 3f, 4f)

        /** A degenerate page would give a non-finite scale, poisoning every coordinate
         *  derived from it, so it falls back to 1:1. */
        private fun safeRatio(available: Float, page: Float): Float =
            if (page > 0f) available / page else 1f

        fun fittingWidth(width: Float, page: PdfSize): PdfZoom =
            PdfZoom(safeRatio(width, page.width), PdfZoomMode.FIT_WIDTH)

        fun fittingSize(viewport: PdfViewport, page: PdfSize): PdfZoom =
            // Whichever dimension runs out first decides; otherwise the page overflows
            // the other.
            PdfZoom(
                minOf(safeRatio(viewport.width, page.width), safeRatio(viewport.height, page.height)),
                PdfZoomMode.FIT_PAGE,
            )
    }
}
