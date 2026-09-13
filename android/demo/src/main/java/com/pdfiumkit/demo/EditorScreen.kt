package com.pdfiumkit.demo

import android.graphics.Bitmap
import android.graphics.RectF
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pdfiumkit.*
import kotlinx.coroutines.launch

/** What a tap or drag on the page does. */
enum class EditorTool(val label: String, val hint: String) {
    SELECT("Select", "Edit fields on the page"),
    INK("Ink", "Drag to draw"),
    NOTE("Note", "Tap to place a note"),
    HIGHLIGHT("Highlight", "Drag over an area"),
}

private val ZOOM_STEPS = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f, 3f, 4f)

/**
 * Viewer, form filling, and annotation on one surface.
 *
 * The page is rendered **without** the forms flag, so PDFium draws each widget's frame
 * but not its value, leaving the rect free for a live Compose control placed with
 * [PdfViewTransform].
 */
@Composable
fun EditorScreen(store: DocumentStore) {
    var pageIndex by remember { mutableIntStateOf(0) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var pageSize by remember { mutableStateOf<PdfSize?>(null) }
    var fields by remember { mutableStateOf<List<PdfFormField>>(emptyList()) }
    var annotations by remember { mutableStateOf<List<PdfAnnotation>>(emptyList()) }

    var tool by remember { mutableStateOf(EditorTool.SELECT) }
    var zoom by remember { mutableStateOf<Float?>(null) }   // null = fit to width
    var selected by remember { mutableStateOf<Int?>(null) }
    var created by remember { mutableIntStateOf(0) }
    var noteAt by remember { mutableStateOf<PdfPoint?>(null) }
    var noteDraft by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }

    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    var viewportPx by remember { mutableIntStateOf(1000) }

    // Scale is fit-to-width unless the user has zoomed.
    val fitScale = pageSize?.let { PdfViewTransform.fittingWidth(it, viewportPx.toFloat()).scale } ?: 1f
    val scale = zoom ?: fitScale
    val transform = pageSize?.let { PdfViewTransform(it, scale) }

    suspend fun reload() {
        val page = store.document?.page(pageIndex) ?: return
        pageSize = page.size()
        fields = page.formFields()
        annotations = page.annotations()
        val width = ((pageSize?.width ?: 1f) * scale).toInt().coerceIn(64, 4000)
        // No forms flag: the live controls below supply the values.
        bitmap = page.render(width = width, options = PdfRenderOptions(annotations = true, forms = false))
    }

    LaunchedEffect(pageIndex, store.revision, scale) { reload() }

    Column(Modifier.fillMaxSize()) {
        EditorToolbar(
            tool = tool,
            onTool = { tool = it; selected = null },
            canUndo = created > 0,
            canDelete = selected != null,
            onUndo = {
                scope.launch {
                    val page = store.document?.page(pageIndex) ?: return@launch
                    if (annotations.isNotEmpty()) {
                        page.removeAnnotation(annotations.size - 1)
                        created--
                        reload()
                    }
                }
            },
            onDelete = {
                scope.launch {
                    val page = store.document?.page(pageIndex) ?: return@launch
                    selected?.let { page.removeAnnotation(it) }
                    selected = null
                    reload()
                }
            },
            onZoom = { direction ->
                val levels = ZOOM_STEPS.map { it * fitScale }
                val current = levels.indexOfFirst { kotlin.math.abs(it - scale) < 0.001f }
                val from = if (current >= 0) current else 2
                zoom = levels[(from + direction).coerceIn(0, levels.lastIndex)]
            },
            onFit = { zoom = null },
            onSave = {
                scope.launch {
                    status = try {
                        val bytes = store.document?.toByteArray() ?: return@launch
                        "Saved ${bytes.size / 1024} KB"
                    } catch (e: PdfError) {
                        "Save failed — ${e.message}"
                    }
                }
            },
        )

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .onSizeChanged { viewportPx = it.width }
                .verticalScroll(rememberScrollState())
                .horizontalScroll(rememberScrollState()),
        ) {
            val image = bitmap
            if (image != null && transform != null) {
                val widthDp = with(density) { image.width.toDp() }
                val heightDp = with(density) { image.height.toDp() }

                Box(Modifier.size(widthDp, heightDp)) {
                    Image(
                        bitmap = image.asImageBitmap(),
                        contentDescription = "Page ${pageIndex + 1}",
                        modifier = Modifier
                            .fillMaxSize()
                            .pageGestures(tool, transform, density.density) { action ->
                                scope.launch {
                                    val page = store.document?.page(pageIndex) ?: return@launch
                                    when (action) {
                                        is PageAction.Select ->
                                            selected = annotations.lastOrNull {
                                                it.base.rect.contains(action.point)
                                            }?.base.let { it?.index }
                                        is PageAction.Note -> {
                                            noteAt = action.point; noteDraft = ""
                                        }
                                        is PageAction.Ink -> {
                                            page.addInk(action.points, PdfColor(0, 90, 220))
                                            created++; reload()
                                        }
                                        is PageAction.Highlight -> {
                                            val r = action.rect
                                            page.addHighlight(listOf(PdfQuad(
                                                PdfPoint(r.left, r.top), PdfPoint(r.right, r.top),
                                                PdfPoint(r.left, r.bottom), PdfPoint(r.right, r.bottom),
                                            )))
                                            created++; reload()
                                        }
                                    }
                                }
                            },
                    )

                    selected?.let { index ->
                        annotations.firstOrNull { it.base.index == index }?.let { annotation ->
                            val box = transform.toView(annotation.base.rect)
                            SelectionBox(box, density.density)
                        }
                    }

                    fields.forEach { field ->
                        FieldControl(field, transform, density.density) { block ->
                            scope.launch {
                                val page = store.document?.page(pageIndex) ?: return@launch
                                block(page)
                                reload()
                            }
                        }
                    }

                    noteAt?.let { point ->
                        InlineNote(
                            point = point,
                            transform = transform,
                            density = density.density,
                            text = noteDraft,
                            onText = { noteDraft = it },
                            onCommit = {
                                scope.launch {
                                    val page = store.document?.page(pageIndex) ?: return@launch
                                    if (noteDraft.isNotEmpty()) {
                                        page.addNote(
                                            PdfRect(point.x, point.y - 24f, point.x + 24f, point.y),
                                            noteDraft,
                                        )
                                        created++
                                    }
                                    noteAt = null
                                    reload()
                                }
                            },
                        )
                    }
                }
            } else {
                Box(Modifier.fillMaxWidth().height(200.dp), Alignment.Center) { CircularProgressIndicator() }
            }
        }

        Surface(tonalElevation = 3.dp) {
            Column(Modifier.fillMaxWidth().padding(12.dp)) {
                Text(
                    status ?: "${tool.hint} · ${fields.size} field(s) · ${annotations.size} annotation(s) · " +
                        "${(scale / fitScale * 100).toInt()}%",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = { pageIndex-- }, enabled = pageIndex > 0) { Text("Previous") }
                    Text("Page ${pageIndex + 1} of ${store.pageCount}")
                    TextButton(onClick = { pageIndex++ }, enabled = pageIndex < store.pageCount - 1) { Text("Next") }
                }
            }
        }
    }
}

@Composable
private fun EditorToolbar(
    tool: EditorTool,
    onTool: (EditorTool) -> Unit,
    canUndo: Boolean,
    canDelete: Boolean,
    onUndo: () -> Unit,
    onDelete: () -> Unit,
    onZoom: (Int) -> Unit,
    onFit: () -> Unit,
    onSave: () -> Unit,
) {
    Surface(tonalElevation = 3.dp) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            EditorTool.entries.forEach { item ->
                FilterChip(
                    selected = tool == item,
                    onClick = { onTool(item) },
                    label = { Text(item.label) },
                    modifier = Modifier.padding(end = 6.dp).semanticsId("tool-${item.name.lowercase()}"),
                )
            }
            TextButton(onClick = onUndo, enabled = canUndo,
                modifier = Modifier.semanticsId("editor-undo")) { Text("Undo") }
            TextButton(onClick = onDelete, enabled = canDelete) { Text("Delete") }
            TextButton(onClick = { onZoom(-1) }, modifier = Modifier.semanticsId("zoom-out")) { Text("−") }
            TextButton(onClick = onFit, modifier = Modifier.semanticsId("zoom-fit")) { Text("Fit") }
            TextButton(onClick = { onZoom(1) }, modifier = Modifier.semanticsId("zoom-in")) { Text("+") }
            TextButton(onClick = onSave, modifier = Modifier.semanticsId("editor-save")) { Text("Save") }
        }
    }
}

/** A live control positioned on the field's own rectangle. */
@Composable
private fun FieldControl(
    field: PdfFormField,
    transform: PdfViewTransform,
    density: Float,
    edit: (suspend (PdfPage) -> Unit) -> Unit,
) {
    val box = transform.toView(field.base.rect)
    val index = field.base.annotationIndex
    val fontSp = (box.height() / density * 0.62f).coerceIn(9f, 18f).sp
    val modifier = Modifier
        .absoluteOffset((box.left / density).dp, (box.top / density).dp)
        .size((box.width() / density).dp, (box.height() / density).dp)
        .semanticsId("field-$index")

    when (field) {
        is PdfFormField.Text -> {
            var draft by remember(field.value) { mutableStateOf(field.value) }
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                textStyle = TextStyle(fontSize = fontSp, color = MaterialTheme.colorScheme.onSurface),
                singleLine = !field.isMultiline,
                // Commit on Done so the page re-renders once, not per keystroke.
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(
                    onDone = { edit { page -> page.setText(draft, fieldAt = index) } }
                ),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = ImeAction.Done),
                modifier = modifier
                    .background(Color.Transparent)
                    .drawBehind { drawFieldBorder() },
            )
        }

        is PdfFormField.CheckBox, is PdfFormField.RadioButton -> {
            // The widget draws its own box but never its check, so supply only the mark.
            val checked = when (field) {
                is PdfFormField.CheckBox -> field.isChecked
                is PdfFormField.RadioButton -> field.isChecked
                else -> false
            }
            TextButton(
                onClick = { edit { page -> page.setChecked(!checked, fieldAt = index) } },
                contentPadding = PaddingValues(0.dp),
                modifier = modifier,
            ) {
                Text(if (checked) "✓" else "", fontSize = fontSp, color = MaterialTheme.colorScheme.primary)
            }
        }

        is PdfFormField.ComboBox, is PdfFormField.ListBox -> {
            val options = when (field) {
                is PdfFormField.ComboBox -> field.options
                is PdfFormField.ListBox -> field.options
                else -> emptyList()
            }
            val value = when (field) {
                is PdfFormField.ComboBox -> field.value
                is PdfFormField.ListBox -> field.value
                else -> ""
            }
            var open by remember { mutableStateOf(false) }
            Box(modifier) {
                TextButton(onClick = { open = true }, contentPadding = PaddingValues(2.dp),
                           modifier = Modifier.fillMaxSize()) {
                    Text(value.ifEmpty { "—" }, fontSize = fontSp, maxLines = 1)
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    options.forEachIndexed { i, option ->
                        DropdownMenuItem(
                            text = { Text(option.ifEmpty { "(blank)" }) },
                            onClick = {
                                open = false
                                edit { page -> page.setOption(i, true, fieldAt = index) }
                            },
                        )
                    }
                }
            }
        }

        else -> Box(modifier.drawBehind { drawFieldBorder(dashed = true) })
    }
}

@Composable
private fun SelectionBox(box: RectF, density: Float) {
    Box(
        Modifier
            .absoluteOffset((box.left / density).dp, (box.top / density).dp)
            .size((box.width() / density).dp.coerceAtLeast(8.dp),
                  (box.height() / density).dp.coerceAtLeast(8.dp))
            .drawBehind {
                drawRect(Color(0xFFFF9800), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 4f))
            },
    )
}

/** A note is typed where it will live, not in a dialog. */
@Composable
private fun InlineNote(
    point: PdfPoint,
    transform: PdfViewTransform,
    density: Float,
    text: String,
    onText: (String) -> Unit,
    onCommit: () -> Unit,
) {
    val origin = transform.toView(point)
    Surface(
        color = Color(0xFFFFF59D),
        tonalElevation = 4.dp,
        modifier = Modifier
            .absoluteOffset((origin.x / density).dp, (origin.y / density).dp)
            .width(190.dp),
    ) {
        Row(Modifier.padding(6.dp), verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = text,
                onValueChange = onText,
                singleLine = true,
                textStyle = TextStyle(fontSize = 13.sp),
                modifier = Modifier.weight(1f).semanticsId("note-input"),
            )
            TextButton(onClick = onCommit, contentPadding = PaddingValues(4.dp)) { Text("Add") }
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawFieldBorder(dashed: Boolean = false) {
    drawRect(
        Color(0x990066CC),
        style = androidx.compose.ui.graphics.drawscope.Stroke(
            width = 2f,
            pathEffect = if (dashed)
                androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(6f, 6f)) else null,
        ),
    )
}

// MARK: - Gestures

private sealed interface PageAction {
    data class Select(val point: PdfPoint) : PageAction
    data class Note(val point: PdfPoint) : PageAction
    data class Ink(val points: List<PdfPoint>) : PageAction
    data class Highlight(val rect: PdfRect) : PageAction
}

private fun Modifier.pageGestures(
    tool: EditorTool,
    transform: PdfViewTransform,
    density: Float,
    onAction: (PageAction) -> Unit,
): Modifier = this
    .pointerInput(tool, transform) {
        detectTapGestures { offset ->
            val point = transform.toPdf(offset.x, offset.y)
            when (tool) {
                EditorTool.SELECT -> onAction(PageAction.Select(point))
                EditorTool.NOTE -> onAction(PageAction.Note(point))
                else -> Unit
            }
        }
    }
    .pointerInput(tool, transform) {
        var stroke = mutableListOf<Offset>()
        var start: Offset? = null
        detectDragGestures(
            onDragStart = { offset -> start = offset; stroke = mutableListOf(offset) },
            onDragEnd = {
                val from = start ?: return@detectDragGestures
                val last = stroke.lastOrNull() ?: return@detectDragGestures
                when (tool) {
                    EditorTool.INK -> if (stroke.size > 1) {
                        onAction(PageAction.Ink(stroke.map { transform.toPdf(it.x, it.y) }))
                    }
                    EditorTool.HIGHLIGHT -> {
                        val rect = RectF(
                            minOf(from.x, last.x), minOf(from.y, last.y),
                            maxOf(from.x, last.x), maxOf(from.y, last.y),
                        )
                        if (rect.width() > 4 && rect.height() > 4) {
                            onAction(PageAction.Highlight(transform.toPdf(rect)))
                        }
                    }
                    else -> Unit
                }
                start = null
                stroke = mutableListOf()
            },
        ) { change, _ ->
            stroke.add(change.position)
        }
    }

/** Test hook: gives a composable a stable identifier for UI tests. */
private fun Modifier.semanticsId(id: String): Modifier =
    this.semantics { contentDescription = id }
