package com.pdfiumkit.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntOffset
import com.pdfiumkit.view.PdfMark
import com.pdfiumkit.view.PdfMarkState
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pdfiumkit.*
import com.pdfiumkit.view.*
import kotlinx.coroutines.launch

/**
 * A drop-in viewer: the page, gestures and a configurable toolbar.
 *
 * It drives a headless [PdfViewer] and owns no state of its own, so behaviour lives in
 * one tested place and this layer can be rewritten without touching the contract
 * underneath. An app that wants full control can use [PdfViewer] directly.
 */
@Composable
fun PdfViewerView(
    document: PdfDocument,
    modifier: Modifier = Modifier,
    toolbar: PdfToolbarConfiguration = PdfToolbarConfiguration.Default,
    theme: PdfViewerTheme = PdfViewerTheme.Light,
    review: PdfReviewConfiguration? = null,
    onSave: ((ByteArray) -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

    var viewer by remember { mutableStateOf<PdfViewer?>(null) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var tool by remember { mutableStateOf(PdfTool.SELECT) }
    var created by remember { mutableIntStateOf(0) }
    var status by remember { mutableStateOf<String?>(null) }
    var viewportPx by remember { mutableStateOf(IntSizeZero) }
    var marks by remember { mutableStateOf(emptyList<PdfMark>()) }

    suspend fun refresh() {
        bitmap = viewer?.render()
    }

    LaunchedEffect(document, viewportPx) {
        if (viewportPx.first <= 0) return@LaunchedEffect
        val port = PdfViewport(viewportPx.first.toFloat(), viewportPx.second.toFloat())
        // An SDK error here, such as a document closed underneath the view, would
        // otherwise escape the composition and take the whole app down.
        try {
            if (viewer == null) {
                viewer = PdfViewer.open(document, port)
                review?.let { viewer?.setMarks(it.marks); marks = viewer?.marks.orEmpty() }
            } else {
                viewer?.setViewport(port)
            }
            refresh()
        } catch (e: PdfError) {
            status = "Could not show the document: ${e.message}"
        }
    }

    Column(modifier.background(theme.background)) {
        PdfToolbar(toolbar.items, theme, tool, canUndo = created > 0, reviewing = review != null) { item ->
            scope.launch {
                val v = viewer ?: return@launch
                when (item) {
                    is PdfToolbarItem.Custom -> item.action()
                    is PdfToolbarItem.Tool -> { tool = item.tool; v.setTool(item.tool) }
                    PdfToolbarItem.Undo -> {
                        val count = document.page(v.state.pageIndex).annotations().size
                        if (count > 0) v.removeAnnotation(count - 1)
                        created = maxOf(0, created - 1)
                        refresh()
                    }
                    PdfToolbarItem.ZoomIn -> { v.zoomIn(); refresh() }
                    PdfToolbarItem.ZoomOut -> { v.zoomOut(); refresh() }
                    PdfToolbarItem.FitWidth -> { v.fitWidth(); refresh() }
                    PdfToolbarItem.PageBack -> { v.goToPage(v.state.pageIndex - 1); refresh() }
                    PdfToolbarItem.PageForward -> { v.goToPage(v.state.pageIndex + 1); refresh() }
                    PdfToolbarItem.Save -> {
                        val bytes = document.toByteArray(PdfSaveMode.FULL)
                        onSave?.invoke(bytes)
                        status = "Saved ${bytes.size / 1024} KB"
                    }
                    else -> Unit
                }
            }
        }

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .onSizeChanged { viewportPx = it.width to it.height }
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState()),
        ) {
            val image = bitmap
            if (image == null) {
                CircularProgressIndicator(Modifier.align(Alignment.Center).padding(40.dp))
            } else {
                Image(
                    bitmap = image.asImageBitmap(),
                    contentDescription = "Page",
                    modifier = Modifier
                        .size(with(density) { image.width.toDp() }, with(density) { image.height.toDp() })
                        .background(theme.pageBackground)
                        .pointerInput(tool, viewer) {
                            var start: Offset? = null
                            var last: Offset? = null
                            detectDragGestures(
                                onDragStart = { start = it; last = it },
                                onDragEnd = {
                                    val from = start
                                    val to = last
                                    start = null
                                    // While reviewing, a tap is about a mark; editing tools stay out of the way.
                                if (from != null && to != null && review == null) {
                                        scope.launch {
                                            status = handleDrag(viewer, tool, from, to) { created += 1 }
                                            refresh()
                                        }
                                    }
                                },
                            ) { change, _ -> last = change.position }
                        },
                )
                val v = viewer
                if (v != null) {
                    val transform = v.transform()
                    marks.filter { it.pageIndex == v.state.pageIndex }.forEach { mark ->
                        mark.rects.forEach { rect ->
                            val box = transform.toView(rect)
                            val (fill, border) = when (mark.state) {
                                PdfMarkState.PENDING -> Color(0x2EFF9500) to Color(0xFFFF9500)
                                PdfMarkState.ACCEPTED -> theme.redactionFill to Color(0xFF1D1D1F)
                                PdfMarkState.REJECTED -> Color.Transparent to Color(0xFF8E8E93)
                            }
                            Box(Modifier
                                .offset { IntOffset(box.left.toInt(), box.top.toInt()) }
                                .size(with(density) { box.width().toDp() }, with(density) { box.height().toDp() })
                                .background(fill)
                                .border(if (mark.state == PdfMarkState.REJECTED) 1.dp else 2.dp, border)
                                .semantics { contentDescription = "mark-${mark.id}" }
                                .clickable {
                                    v.tapMark(mark.pageIndex, transform.toPdf(box.centerX(), box.centerY()))
                                    marks = v.marks
                                })
                        }
                    }
                }
            }
        }

        review?.let {
            PdfReviewBar(it, marks, theme) { state -> viewer?.setAllMarks(state); marks = viewer?.marks.orEmpty() }
        }

        status?.let {
            Text(it, Modifier.padding(6.dp), style = MaterialTheme.typography.bodySmall)
        }
    }
}

private val IntSizeZero = 0 to 0

/** Turns a drag into whichever edit the current tool means. */
private suspend fun handleDrag(
    viewer: PdfViewer?,
    tool: PdfTool,
    from: Offset,
    to: Offset,
    onCreated: () -> Unit,
): String? {
    val v = viewer ?: return null
    val t = v.transform()
    return when (tool) {
        PdfTool.SELECT -> null
        PdfTool.NOTE -> {
            val p = t.toPdf(to.x, to.y)
            v.addNote(PdfRect(p.x, p.y - 24f, p.x + 24f, p.y), "Note")
            onCreated(); null
        }
        PdfTool.INK -> {
            v.addInk(listOf(listOf(t.toPdf(from.x, from.y), t.toPdf(to.x, to.y))))
            onCreated(); null
        }
        PdfTool.HIGHLIGHT, PdfTool.REDACT -> {
            val rect = PdfRect(
                minOf(from.x, to.x), 0f, maxOf(from.x, to.x), 0f,
            ).let {
                val topLeft = t.toPdf(minOf(from.x, to.x), minOf(from.y, to.y))
                val bottomRight = t.toPdf(maxOf(from.x, to.x), maxOf(from.y, to.y))
                PdfRect(topLeft.x, bottomRight.y, bottomRight.x, topLeft.y)
            }
            if (tool == PdfTool.REDACT) {
                describe(v.redact(listOf(PdfRedactionTarget.Region(rect, v.state.pageIndex))))
            } else {
                v.addHighlight(listOf(PdfQuad(
                    PdfPoint(rect.left, rect.top), PdfPoint(rect.right, rect.top),
                    PdfPoint(rect.left, rect.bottom), PdfPoint(rect.right, rect.bottom),
                )))
                onCreated(); null
            }
        }
    }
}

private fun describe(report: PdfRedactionReport): String {
    val parts = listOf(
        report.textObjects to "text object", report.images to "image",
        report.paths to "path", report.annotations to "annotation",
    ).filter { it.first > 0 }.map { "${it.first} ${it.second}${if (it.first == 1) "" else "s"}" }
    return if (parts.isEmpty()) "Nothing in that region to redact"
    else "Redacted ${parts.joinToString(", ")} — save to write it out"
}

/**
 * The toolbar, which **must not clip**.
 *
 * Every item has a fixed width, so a plain row overflows rather than wrapping and
 * whatever does not fit is silently cut off. This project shipped that bug once already,
 * and a configurable toolbar makes it likelier because apps add items — so this scrolls.
 */
@Composable
private fun PdfToolbar(
    items: List<PdfToolbarItem>,
    theme: PdfViewerTheme,
    tool: PdfTool,
    canUndo: Boolean,
    reviewing: Boolean,
    onItem: (PdfToolbarItem) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(theme.toolbarHeight)
            .background(theme.toolbarBackground)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items.forEach { item ->
            when (item) {
                PdfToolbarItem.Spacer -> Spacer(Modifier.width(12.dp))
                PdfToolbarItem.Divider ->
                    Box(Modifier.width(1.dp).height(24.dp).background(theme.toolbarForeground.copy(alpha = 0.2f)))
                else -> {
                    val active = item is PdfToolbarItem.Tool && item.tool == tool
                    IconButton(
                        onClick = { onItem(item) },
                        enabled = (item != PdfToolbarItem.Undo || canUndo) && !(reviewing && item is PdfToolbarItem.Tool),
                        modifier = Modifier
                            .size(36.dp)
                            .clip(RoundedCornerShape(theme.cornerRadius))
                            .background(if (active) theme.accent.copy(alpha = 0.18f) else Color_Transparent)
                            .semantics { contentDescription = item.id },
                    ) {
                        Icon(item.icon, item.label, tint = theme.toolbarForeground)
                    }
                }
            }
        }
    }
}

private val Color_Transparent = androidx.compose.ui.graphics.Color.Transparent
