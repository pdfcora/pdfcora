package com.pdfiumkit.view

import android.graphics.Bitmap
import com.pdfiumkit.PdfColor
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfPageRotation
import com.pdfiumkit.PdfPoint
import com.pdfiumkit.PdfRect
import com.pdfiumkit.PdfRenderOptions
import com.pdfiumkit.PdfSize
import com.pdfiumkit.PdfViewTransform
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

data class PdfViewerOptions(
    val sessionId: String = UUID.randomUUID().toString(),
    /** Viewport changes are coalesced over this window, in milliseconds. Edits are not. */
    val coalesceMillis: Long = 50,
)

/**
 * Where a viewer is looking, and what changes it.
 *
 * Headless: it owns no view. The app draws, asks [scrollOffset] where to scroll and
 * [render] what to paint, and reports gestures back in. Everything that changes it emits
 * an event, and [apply] is the inverse — which is what lets two viewers on different
 * platforms stay in step.
 */
class PdfViewer private constructor(
    private val document: PdfDocument,
    private var viewport: PdfViewport,
    private var pageSize: PdfSize,
    private val pageCount: Int,
    private val options: PdfViewerOptions,
    initial: PdfViewState,
) {
    private val lock = Mutex()
    private val _events = MutableSharedFlow<PdfViewEvent>(extraBufferCapacity = 64)
    private var sequence = 0
    /** Highest sequence seen per remote session, so late delivery cannot rewind us. */
    private val seen = mutableMapOf<String, Int>()
    private var pending: PdfViewState? = null
    private var lastEmitted = 0L

    var state: PdfViewState = initial
        private set
    var selection: PdfSelection? = null
        private set
    var tool: PdfTool = PdfTool.SELECT
        private set

    val events: Flow<PdfViewEvent> get() = _events

    companion object {
        suspend fun open(
            document: PdfDocument,
            viewport: PdfViewport,
            options: PdfViewerOptions = PdfViewerOptions(),
        ): PdfViewer {
            val pageCount = document.pageCount()
            val pageSize = document.page(0).size()
            return PdfViewer(
                document, viewport, pageSize, pageCount, options,
                PdfViewState(
                    pageIndex = 0,
                    center = PdfPoint(pageSize.width / 2f, pageSize.height / 2f),
                    zoom = PdfZoom.fittingWidth(viewport.width, pageSize),
                    rotation = PdfPageRotation.NONE,
                    layout = PdfPageLayout.SINGLE,
                ),
            )
        }
    }

    // MARK: - Geometry

    fun transform(): PdfViewTransform = PdfViewTransform(pageSize, state.zoom.scale)

    /** Where the app should scroll so the state's centre sits in the middle. */
    fun scrollOffset(): PdfViewOffset = transform().scrollOffsetCentering(state.center, viewport)

    suspend fun render(
        options: PdfRenderOptions = PdfRenderOptions.DEFAULT,
        background: PdfColor = PdfColor(255, 255, 255),
    ): Bitmap {
        // Rendered at the zoomed size rather than scaling one bitmap up, so text stays sharp.
        val width = Math.round(pageSize.width * state.zoom.scale)
        return document.page(state.pageIndex)
            .render(width.coerceIn(1, 4000), options, background)
    }

    // MARK: - Viewport

    suspend fun setViewport(size: PdfViewport) {
        viewport = size
        // A fit is a promise about the window, so it is re-derived. A free zoom is the
        // user's deliberate choice and survives.
        val zoom = if (state.zoom.mode == PdfZoomMode.FREE) state.zoom else refit(state.zoom.mode)
        update(state.copy(zoom = zoom))
    }

    suspend fun scrollTo(center: PdfPoint, page: Int = state.pageIndex) {
        update(state.copy(pageIndex = clampPage(page), center = center))
    }

    suspend fun scrollBy(dx: Float, dy: Float) {
        val offset = scrollOffset()
        val moved = PdfViewOffset(offset.x + dx, offset.y + dy)
        update(state.copy(center = transform().centerForScrollOffset(moved, viewport)))
    }

    suspend fun goToPage(index: Int) {
        val page = clampPage(index)
        pageSize = document.page(page).size()
        val zoom = if (state.zoom.mode == PdfZoomMode.FREE) state.zoom else refit(state.zoom.mode)
        update(state.copy(
            pageIndex = page,
            center = PdfPoint(pageSize.width / 2f, pageSize.height / 2f),
            zoom = zoom,
        ))
    }

    suspend fun zoomTo(zoom: PdfZoom) = update(state.copy(zoom = zoom))
    suspend fun zoomIn() = zoomTo(state.zoom.stepped(1))
    suspend fun zoomOut() = zoomTo(state.zoom.stepped(-1))
    suspend fun fitWidth() = zoomTo(refit(PdfZoomMode.FIT_WIDTH))
    suspend fun fitPage() = zoomTo(refit(PdfZoomMode.FIT_PAGE))
    suspend fun setRotation(rotation: PdfPageRotation) = update(state.copy(rotation = rotation))
    suspend fun setLayout(layout: PdfPageLayout) = update(state.copy(layout = layout))

    // MARK: - Selection and tools

    suspend fun selectRegion(page: Int, rect: PdfRect) = setSelection(PdfSelection.Region(page, rect))
    suspend fun selectAnnotation(page: Int, index: Int) = setSelection(PdfSelection.Annotation(page, index))
    suspend fun clearSelection() = setSelection(null)

    suspend fun setTool(tool: PdfTool) {
        this.tool = tool
        emit(PdfViewChange.Tool(tool))
    }

    // MARK: - Sync

    /**
     * Applies a peer's event.
     *
     * Emits nothing — without that, two synced viewers echo each other forever — and
     * ignores anything at or below the highest sequence already seen from that session,
     * so late delivery cannot rewind the view.
     */
    suspend fun apply(event: PdfViewEvent) = lock.withLock {
        val highest = seen[event.sessionId]
        if (highest != null && event.sequence <= highest) return@withLock
        seen[event.sessionId] = event.sequence

        when (val change = event.change) {
            is PdfViewChange.Viewport -> {
                val incoming = change.state
                // A fit is re-derived for *this* window; a free zoom is adopted verbatim.
                val zoom = if (incoming.zoom.mode == PdfZoomMode.FREE) incoming.zoom
                           else refit(incoming.zoom.mode)
                state = incoming.copy(zoom = zoom)
            }
            is PdfViewChange.Selection -> selection = change.selection
            is PdfViewChange.Tool -> tool = change.tool
        }
    }

    /** Emits any pending viewport change immediately. For tests and for teardown. */
    suspend fun flush() {
        val latest = pending ?: return
        pending = null
        emit(PdfViewChange.Viewport(latest))
    }

    // MARK: - Internals

    private fun clampPage(index: Int) = index.coerceIn(0, maxOf(0, pageCount - 1))

    private fun refit(mode: PdfZoomMode): PdfZoom = when (mode) {
        PdfZoomMode.FIT_WIDTH -> PdfZoom.fittingWidth(viewport.width, pageSize)
        else -> PdfZoom.fittingSize(viewport, pageSize)
    }

    private suspend fun setSelection(selection: PdfSelection?) {
        this.selection = selection
        emit(PdfViewChange.Selection(selection))
    }

    private suspend fun update(next: PdfViewState) {
        state = next
        // Viewport changes coalesce: a drag produces them at gesture rate and only the
        // latest matters. Selection and tool changes are emitted immediately, since each
        // is meaningful on its own and dropping one loses information.
        pending = next
        val now = System.currentTimeMillis()
        if (now - lastEmitted >= options.coalesceMillis) {
            lastEmitted = now
            flush()
        }
    }

    private suspend fun emit(change: PdfViewChange) {
        sequence += 1
        _events.emit(PdfViewEvent(sequence, options.sessionId, PdfViewEventOrigin.LOCAL, change))
    }
}
