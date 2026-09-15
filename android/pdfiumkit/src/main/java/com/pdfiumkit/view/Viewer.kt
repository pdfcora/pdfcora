package com.pdfiumkit.view

import android.graphics.Bitmap
import com.pdfiumkit.PdfColor
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfPageRotation
import com.pdfiumkit.PdfPoint
import com.pdfiumkit.PdfQuad
import com.pdfiumkit.PdfRect
import com.pdfiumkit.PdfRedactionReport
import com.pdfiumkit.PdfRedactionTarget
import com.pdfiumkit.addHighlight
import com.pdfiumkit.addInk
import com.pdfiumkit.addNote
import com.pdfiumkit.annotations
import com.pdfiumkit.contains
import com.pdfiumkit.redact
import com.pdfiumkit.removeAnnotation
import com.pdfiumkit.setChecked
import com.pdfiumkit.setOption
import com.pdfiumkit.setText
import com.pdfiumkit.PdfRenderOptions
import com.pdfiumkit.PdfSize
import com.pdfiumkit.PdfViewTransform
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

enum class PdfViewerRole { PRESENTER, FOLLOWER }

class PdfFollowerException : IllegalStateException(
    "this viewer is following another session and cannot edit the document",
)

class PdfDocumentMismatchException(expected: String, received: String) : IllegalArgumentException(
    "edit is for a different document (expected $expected, received $received)",
)

data class PdfViewerOptions(
    val sessionId: String = UUID.randomUUID().toString(),
    /** Viewport changes are coalesced over this window, in milliseconds. Edits are not. */
    val coalesceMillis: Long = 50,
    /**
     * A follower may look wherever it likes but may not change the document.
     *
     * Concurrent editing is deliberately out of scope: two people editing one annotation
     * is a distributed-systems problem, and last-writer-wins silently discards work.
     */
    val role: PdfViewerRole = PdfViewerRole.PRESENTER,
    /** When set, only this session's edits are applied. Others are ignored. */
    val presenterId: String? = null,
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

    // MARK: - Marks
    //
    // Local to this viewer: none of these emit an event, so a sync transport never carries a
    // review, and none touch the document.

    @Volatile var marks: List<PdfMark> = emptyList()
        private set

    fun setMarks(marks: List<PdfMark>) { this.marks = marks.toList() }

    fun setAllMarks(state: PdfMarkState) { marks = marks.map { it.copy(state = state) } }

    /** The id of the topmost mark under a point on a page — the last one set — or null. */
    fun markAt(page: Int, point: PdfPoint): String? =
        marks.lastOrNull { mark -> mark.pageIndex == page && mark.rects.any { it.contains(point) } }?.id

    /** Cycles the tapped mark PENDING → ACCEPTED → REJECTED → PENDING. Returns its id, or null. */
    fun tapMark(page: Int, point: PdfPoint): String? {
        val id = markAt(page, point) ?: return null
        marks = marks.map { mark ->
            if (mark.id != id) mark else mark.copy(state = when (mark.state) {
                PdfMarkState.PENDING -> PdfMarkState.ACCEPTED
                PdfMarkState.ACCEPTED -> PdfMarkState.REJECTED
                PdfMarkState.REJECTED -> PdfMarkState.PENDING
            })
        }
        return id
    }

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

    // MARK: - Editing
    //
    // Every method delegates to the existing page API and then emits. Two code paths
    // producing annotations would drift, and the bug would surface through only one of
    // them — ViewerEditingTest asserts byte identity to stop that.
    //
    // A follower refuses to edit locally. It may still scroll and zoom: following is not
    // the same as being frozen.

    /** The bytes this viewer's document was opened from. An edit is refused unless the
     *  sender's matches. */
    val documentFingerprint: String get() = document.fingerprint

    suspend fun addNote(rect: PdfRect, contents: String, color: PdfColor = PdfColor.YELLOW): Int {
        requirePresenter()
        val index = document.page(state.pageIndex).addNote(rect, contents, color)
        emitEdit(PdfEdit.NoteAdded(state.pageIndex, rect, contents, color))
        return index
    }

    suspend fun addInk(strokes: List<List<PdfPoint>>, color: PdfColor = PdfColor.BLACK,
                       lineWidth: Float = 2f): Int {
        requirePresenter()
        val index = document.page(state.pageIndex).addInk(strokes, color, lineWidth)
        emitEdit(PdfEdit.InkAdded(state.pageIndex, strokes, color, lineWidth))
        return index
    }

    suspend fun addHighlight(quads: List<PdfQuad>, color: PdfColor = PdfColor.YELLOW): Int {
        requirePresenter()
        val index = document.page(state.pageIndex).addHighlight(quads, color)
        emitEdit(PdfEdit.HighlightAdded(state.pageIndex, quads, color))
        return index
    }

    suspend fun removeAnnotation(index: Int) {
        requirePresenter()
        document.page(state.pageIndex).removeAnnotation(index)
        emitEdit(PdfEdit.AnnotationRemoved(state.pageIndex, index))
    }

    suspend fun setFieldText(value: String, annotationIndex: Int) {
        requirePresenter()
        document.page(state.pageIndex).setText(value, annotationIndex)
        emitEdit(PdfEdit.FieldTextSet(state.pageIndex, annotationIndex, value))
    }

    suspend fun setFieldChecked(checked: Boolean, annotationIndex: Int) {
        requirePresenter()
        document.page(state.pageIndex).setChecked(checked, annotationIndex)
        emitEdit(PdfEdit.FieldCheckedSet(state.pageIndex, annotationIndex, checked))
    }

    suspend fun setFieldOption(option: Int, selected: Boolean, annotationIndex: Int) {
        requirePresenter()
        document.page(state.pageIndex).setOption(option, selected, annotationIndex)
        emitEdit(PdfEdit.FieldOptionSet(state.pageIndex, annotationIndex, option, selected))
    }

    /**
     * Removes content so it cannot be recovered.
     *
     * **Save with [com.pdfiumkit.PdfSaveMode.FULL] afterwards** — an incremental save
     * leaves the original content stream in the file, and the removed content with it.
     */
    suspend fun redact(targets: List<PdfRedactionTarget>): PdfRedactionReport {
        requirePresenter()
        val report = document.redact(targets)
        emitEdit(PdfEdit.Redacted(targets))
        return report
    }

    private fun requirePresenter() {
        if (options.role == PdfViewerRole.FOLLOWER) throw PdfFollowerException()
    }

    /** Edits bypass the viewport coalescing: a viewport change may be dropped in favour
     *  of a later one, an annotation added is not superseded by the next. */
    private suspend fun emitEdit(edit: PdfEdit) {
        sequence += 1
        _events.emit(PdfViewEvent(sequence, options.sessionId, PdfViewEventOrigin.LOCAL,
                                  PdfViewChange.Edit(edit), document.fingerprint))
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
            is PdfViewChange.Edit -> applyIncomingEdit(event, change.edit)
        }
    }

    /**
     * Replays a peer's edit. Emits nothing.
     *
     * Refuses one meant for other bytes — indices are positions in a specific document —
     * but ignores one from a session that is not the presenter rather than throwing: in a
     * broadcast transport everyone hears everyone, and throwing would turn a third
     * participant's stray edit into an error on every peer.
     */
    private suspend fun applyIncomingEdit(event: PdfViewEvent, edit: PdfEdit) {
        val theirs = event.documentFingerprint
        if (theirs != null && theirs != document.fingerprint) {
            throw PdfDocumentMismatchException(document.fingerprint, theirs)
        }
        if (options.presenterId != null && event.sessionId != options.presenterId) return
        replay(edit)
    }

    private suspend fun replay(edit: PdfEdit) {
        when (edit) {
            is PdfEdit.NoteAdded ->
                document.page(edit.page).addNote(edit.rect, edit.contents, edit.color)
            is PdfEdit.InkAdded ->
                document.page(edit.page).addInk(edit.strokes, edit.color, edit.lineWidth)
            is PdfEdit.HighlightAdded ->
                document.page(edit.page).addHighlight(edit.quads, edit.color)
            is PdfEdit.AnnotationRemoved ->
                document.page(edit.page).removeAnnotation(edit.index)
            is PdfEdit.FieldTextSet ->
                document.page(edit.page).setText(edit.value, edit.annotationIndex)
            is PdfEdit.FieldCheckedSet ->
                document.page(edit.page).setChecked(edit.checked, edit.annotationIndex)
            is PdfEdit.FieldOptionSet ->
                document.page(edit.page).setOption(edit.option, edit.selected, edit.annotationIndex)
            is PdfEdit.Redacted -> document.redact(edit.targets)
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
