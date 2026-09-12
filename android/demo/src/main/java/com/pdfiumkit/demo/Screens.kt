package com.pdfiumkit.demo

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.pdfiumkit.*
import kotlinx.coroutines.launch
import java.io.File

// MARK: - Viewer

@Composable
fun ViewerScreen(store: DocumentStore) {
    var pageIndex by remember { mutableIntStateOf(0) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(pageIndex, store.revision) {
        bitmap = store.document?.page(pageIndex)?.render(width = 1000)
    }

    Column(Modifier.fillMaxSize()) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            bitmap?.let {
                Image(it.asImageBitmap(), contentDescription = "Page ${pageIndex + 1}",
                      modifier = Modifier.fillMaxWidth().padding(16.dp))
            } ?: CircularProgressIndicator()
        }
        PageBar(pageIndex, store.pageCount) { pageIndex = it }
    }
}

@Composable
private fun PageBar(pageIndex: Int, pageCount: Int, onChange: (Int) -> Unit) {
    Surface(tonalElevation = 3.dp) {
        Row(Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { onChange(pageIndex - 1) }, enabled = pageIndex > 0) { Text("Previous") }
            Text("Page ${pageIndex + 1} of $pageCount")
            TextButton(onClick = { onChange(pageIndex + 1) }, enabled = pageIndex < pageCount - 1) { Text("Next") }
        }
    }
}

// MARK: - Search

@Composable
fun SearchScreen(store: DocumentStore) {
    var query by remember { mutableStateOf("") }
    var caseSensitive by remember { mutableStateOf(false) }
    var hits by remember { mutableStateOf<List<Pair<Int, PdfTextMatch>>>(emptyList()) }
    var searched by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        OutlinedTextField(
            value = query, onValueChange = { query = it },
            label = { Text("Search the document") }, singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Checkbox(caseSensitive, onCheckedChange = { caseSensitive = it })
            Text("Case sensitive")
            Spacer(Modifier.weight(1f))
            Button(enabled = query.isNotEmpty(), onClick = {
                scope.launch {
                    val document = store.document ?: return@launch
                    val options = PdfSearchOptions(caseSensitive = caseSensitive)
                    val found = mutableListOf<Pair<Int, PdfTextMatch>>()
                    for (i in 0 until store.pageCount) {
                        document.page(i).text.search(query, options).forEach { found += i to it }
                    }
                    hits = found
                    searched = true
                }
            }) { Text("Find") }
        }
        Spacer(Modifier.height(8.dp))
        if (searched && hits.isEmpty()) {
            Text("No matches for “$query”.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LazyColumn {
            items(hits) { (page, match) ->
                ListItem(
                    headlineContent = { Text("Page ${page + 1}") },
                    supportingContent = {
                        Text("characters ${match.start}–${match.start + match.length}, ${match.rects.size} rect(s)")
                    }
                )
            }
        }
    }
}

// MARK: - Outline

@Composable
fun OutlineScreen(store: DocumentStore) {
    var outline by remember { mutableStateOf<List<PdfOutlineItem>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(store.revision) {
        outline = store.document?.outline() ?: emptyList()
        loaded = true
    }

    if (!loaded) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
    } else if (outline.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text("This document has no outline.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    } else {
        LazyColumn(Modifier.fillMaxSize()) {
            outlineRows(outline, 0)
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.outlineRows(
    items: List<PdfOutlineItem>, depth: Int,
) {
    items.forEach { item ->
        item {
            ListItem(
                headlineContent = { Text(item.title.ifEmpty { "(untitled)" }) },
                trailingContent = { item.pageIndex?.let { Text("p.${it + 1}") } },
                modifier = Modifier.padding(start = (depth * 16).dp)
            )
        }
        outlineRows(item.children, depth + 1)
    }
}

// MARK: - Thumbnails

@Composable
fun ThumbnailsScreen(store: DocumentStore) {
    val thumbnails = remember(store.revision) { mutableStateMapOf<Int, Bitmap>() }

    LazyVerticalGrid(columns = GridCells.Adaptive(110.dp), contentPadding = PaddingValues(16.dp)) {
        items((0 until store.pageCount).toList()) { index ->
            LaunchedEffect(index, store.revision) {
                if (thumbnails[index] == null) {
                    store.document?.page(index)?.render(width = 200)?.let { thumbnails[index] = it }
                }
            }
            Column(Modifier.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                thumbnails[index]?.let {
                    Image(it.asImageBitmap(), contentDescription = "Page ${index + 1}",
                          modifier = Modifier.fillMaxWidth())
                } ?: Box(Modifier.fillMaxWidth().height(140.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
                Text("${index + 1}", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

// MARK: - Annotations

@Composable
fun AnnotationsScreen(store: DocumentStore) {
    var annotations by remember { mutableStateOf<List<PdfAnnotation>>(emptyList()) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(store.revision) {
        val page = store.document?.page(0) ?: return@LaunchedEffect
        annotations = page.annotations()
        bitmap = page.render(width = 800)
    }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            bitmap?.let {
                Image(it.asImageBitmap(), contentDescription = "Page 1",
                      modifier = Modifier.fillMaxWidth().padding(16.dp))
            }
            Text("${annotations.size} annotation(s) on page 1",
                 Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.titleSmall)
            annotations.forEach { annotation ->
                ListItem(
                    headlineContent = { Text(annotation.label(), fontFamily = FontFamily.Monospace) },
                    supportingContent = { annotation.base.contents?.let { Text(it) } }
                )
            }
        }
        Surface(tonalElevation = 3.dp) {
            Row(Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.SpaceEvenly) {
                TextButton(onClick = {
                    store.edit { document ->
                        val stroke = (0..20).map {
                            val t = it / 20f
                            PdfPoint(40f + t * 120f, 90f + kotlin.math.sin(t * Math.PI * 2).toFloat() * 25f)
                        }
                        document.page(0).addInk(stroke, PdfColor(0, 90, 220))
                    }
                }) { Text("Add ink") }
                TextButton(onClick = {
                    store.edit { it.page(0).addNote(PdfRect(30f, 30f, 60f, 60f), "Added from the demo") }
                }) { Text("Add note") }
                TextButton(
                    enabled = annotations.isNotEmpty(),
                    onClick = { store.edit { it.page(0).removeAnnotation(annotations.size - 1) } }
                ) { Text("Remove last") }
            }
        }
    }
}

/** Exhaustive matching — adding a case to PdfAnnotation surfaces here at compile time. */
private fun PdfAnnotation.label(): String = when (this) {
    is PdfAnnotation.Highlight -> "highlight"
    is PdfAnnotation.Underline -> "underline"
    is PdfAnnotation.Strikeout -> "strikeout"
    is PdfAnnotation.Squiggly -> "squiggly"
    is PdfAnnotation.Ink -> "ink (${strokes.size} strokes)"
    is PdfAnnotation.FreeText -> "freeText"
    is PdfAnnotation.Square -> "square"
    is PdfAnnotation.Circle -> "circle"
    is PdfAnnotation.Line -> "line"
    is PdfAnnotation.Note -> "note"
    is PdfAnnotation.Link -> "link"
    is PdfAnnotation.Stamp -> "stamp"
    is PdfAnnotation.FileAttachment -> "fileAttachment"
    is PdfAnnotation.Widget -> "widget ${fieldName ?: ""}"
    is PdfAnnotation.Unknown -> "unknown (subtype $subtypeCode)"
}

// MARK: - Forms

@Composable
fun FormsScreen(store: DocumentStore) {
    var fields by remember { mutableStateOf<List<PdfFormField>>(emptyList()) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(store.revision) {
        val page = store.document?.page(0) ?: return@LaunchedEffect
        fields = page.formFields()
        bitmap = page.render(width = 800)
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        if (fields.isEmpty()) {
            Text("This document has no interactive form fields.", Modifier.padding(24.dp),
                 color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // Each field type gets the control that suits it — the point of the sealed hierarchy.
        fields.forEach { field ->
            val name = field.base.name ?: field.base.alternateName ?: "field ${field.base.annotationIndex}"
            when (field) {
                is PdfFormField.Text -> {
                    var draft by remember(store.revision, field.base.annotationIndex) {
                        mutableStateOf(field.value)
                    }
                    OutlinedTextField(
                        value = draft, onValueChange = { draft = it },
                        label = { Text(name) }, singleLine = !field.isMultiline,
                        modifier = Modifier.fillMaxWidth().padding(16.dp, 8.dp),
                        trailingIcon = {
                            TextButton(onClick = {
                                store.edit { it.page(0).setText(draft, fieldAt = field.base.annotationIndex) }
                            }) { Text("Set") }
                        }
                    )
                }
                is PdfFormField.CheckBox -> FieldToggle(name, field.isChecked) { checked ->
                    store.edit { it.page(0).setChecked(checked, fieldAt = field.base.annotationIndex) }
                }
                is PdfFormField.RadioButton -> FieldToggle(name, field.isChecked) { checked ->
                    store.edit { it.page(0).setChecked(checked, fieldAt = field.base.annotationIndex) }
                }
                is PdfFormField.ComboBox -> ChoiceField(name, field.options, field.selectedIndices) { option ->
                    store.edit { it.page(0).setOption(option, true, fieldAt = field.base.annotationIndex) }
                }
                is PdfFormField.ListBox -> ChoiceField(name, field.options, field.selectedIndices) { option ->
                    store.edit { it.page(0).setOption(option, true, fieldAt = field.base.annotationIndex) }
                }
                is PdfFormField.PushButton -> ListItem(
                    headlineContent = { Text(name) }, trailingContent = { Text("button") })
                is PdfFormField.Signature -> ListItem(
                    headlineContent = { Text(name) }, trailingContent = { Text("signature") })
                is PdfFormField.Unknown -> ListItem(
                    headlineContent = { Text(name) }, trailingContent = { Text("type ${field.typeCode}") })
            }
        }
        bitmap?.let {
            Image(it.asImageBitmap(), contentDescription = "Rendered form",
                  modifier = Modifier.fillMaxWidth().padding(16.dp))
        }
    }
}

@Composable
private fun FieldToggle(name: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    ListItem(
        headlineContent = { Text(name) },
        trailingContent = { Switch(checked = checked, onCheckedChange = onChange) }
    )
}

@Composable
private fun ChoiceField(name: String, options: List<String>, selected: List<Int>, onSelect: (Int) -> Unit) {
    Column(Modifier.padding(16.dp, 8.dp)) {
        Text(name, style = MaterialTheme.typography.labelLarge)
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            options.forEachIndexed { index, option ->
                FilterChip(
                    selected = index in selected,
                    onClick = { onSelect(index) },
                    label = { Text(option.ifEmpty { "(blank)" }) },
                    modifier = Modifier.padding(end = 8.dp)
                )
            }
        }
    }
}

// MARK: - Text

@Composable
fun TextScreen(store: DocumentStore) {
    var pageIndex by remember { mutableIntStateOf(0) }
    var text by remember { mutableStateOf("") }
    var charCount by remember { mutableIntStateOf(0) }
    val context = LocalContext.current

    LaunchedEffect(pageIndex, store.revision) {
        val page = store.document?.page(pageIndex) ?: return@LaunchedEffect
        text = page.text.string()
        charCount = page.text.characterCount()
    }

    Column(Modifier.fillMaxSize()) {
        SelectionContainer(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp)) {
            Text(text.ifEmpty { "This page has no extractable text." }, fontFamily = FontFamily.Monospace)
        }
        Surface(tonalElevation = 3.dp) {
            Row(Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { pageIndex-- }, enabled = pageIndex > 0) { Text("Previous") }
                Text("Page ${pageIndex + 1} — $charCount chars")
                TextButton(enabled = text.isNotEmpty(), onClick = {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("page text", text))
                }) { Text("Copy") }
                TextButton(onClick = { pageIndex++ }, enabled = pageIndex < store.pageCount - 1) { Text("Next") }
            }
        }
    }
}

// MARK: - Document info

@Composable
fun InfoScreen(store: DocumentStore) {
    var metadata by remember { mutableStateOf<PdfMetadata?>(null) }
    var permissions by remember { mutableStateOf(PdfPermissions(0)) }
    var attachments by remember { mutableStateOf<List<PdfAttachment>>(emptyList()) }

    LaunchedEffect(store.revision) {
        val document = store.document ?: return@LaunchedEffect
        metadata = document.metadata()
        permissions = document.permissions()
        attachments = document.attachments()
    }

    LazyColumn(Modifier.fillMaxSize()) {
        item { SectionHeader("Engine") }
        item { InfoRow("PDFium", PdfDocument.ENGINE_VERSION) }
        item { InfoRow("Pages", "${store.pageCount}") }
        item { SectionHeader("Metadata") }
        item { InfoRow("Title", metadata?.title ?: "—") }
        item { InfoRow("Author", metadata?.author ?: "—") }
        item { InfoRow("Subject", metadata?.subject ?: "—") }
        item { InfoRow("Creator", metadata?.creator ?: "—") }
        item { InfoRow("Producer", metadata?.producer ?: "—") }
        item { SectionHeader("Permissions") }
        item { InfoRow("Print", if (permissions.canPrint) "✓" else "✗") }
        item { InfoRow("Modify", if (permissions.canModify) "✓" else "✗") }
        item { InfoRow("Copy", if (permissions.canCopy) "✓" else "✗") }
        item { InfoRow("Annotate", if (permissions.canAnnotate) "✓" else "✗") }
        item { InfoRow("Fill forms", if (permissions.canFillForms) "✓" else "✗") }
        item { SectionHeader("Attachments") }
        if (attachments.isEmpty()) {
            item { InfoRow("None", "") }
        } else {
            items(attachments) { InfoRow(it.name, "") }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(text, Modifier.padding(16.dp, 24.dp, 16.dp, 4.dp),
         style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun InfoRow(label: String, value: String) {
    ListItem(headlineContent = { Text(label) }, trailingContent = { Text(value) })
}

// MARK: - Page operations

@Composable
fun PageOpsScreen(store: DocumentStore) {
    var pageIndex by remember { mutableIntStateOf(0) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    var rotation by remember { mutableStateOf(PdfPageRotation.NONE) }
    var size by remember { mutableStateOf<PdfSize?>(null) }

    LaunchedEffect(pageIndex, store.revision) {
        val page = store.document?.page(pageIndex) ?: return@LaunchedEffect
        rotation = page.rotation()
        size = page.size()
        bitmap = page.render(width = 800)
    }

    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
               horizontalAlignment = Alignment.CenterHorizontally) {
            bitmap?.let {
                Image(it.asImageBitmap(), contentDescription = "Page ${pageIndex + 1}",
                      modifier = Modifier.fillMaxWidth().padding(16.dp))
            }
            size?.let {
                Text("%.0f × %.0f pt · rotation %d°".format(it.width, it.height, rotation.raw * 90),
                     style = MaterialTheme.typography.labelSmall)
            }
        }
        Surface(tonalElevation = 3.dp) {
            Row(Modifier.fillMaxWidth().padding(12.dp),
                horizontalArrangement = Arrangement.SpaceEvenly) {
                TextButton(onClick = { pageIndex-- }, enabled = pageIndex > 0) { Text("Previous") }
                TextButton(onClick = {
                    store.edit {
                        val next = PdfPageRotation.fromRaw((rotation.raw + 3) % 4)
                        it.page(pageIndex).setRotation(next)
                    }
                }) { Text("Rotate ↺") }
                TextButton(onClick = {
                    store.edit {
                        val next = PdfPageRotation.fromRaw((rotation.raw + 1) % 4)
                        it.page(pageIndex).setRotation(next)
                    }
                }) { Text("Rotate ↻") }
                TextButton(onClick = { pageIndex++ }, enabled = pageIndex < store.pageCount - 1) { Text("Next") }
            }
        }
    }
}

// MARK: - Export

@Composable
fun ExportScreen(store: DocumentStore) {
    var mode by remember { mutableStateOf(PdfSaveMode.FULL) }
    var status by remember { mutableStateOf("Add an annotation or fill a form, then export.") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Mode", style = MaterialTheme.typography.labelLarge)
        Row {
            FilterChip(mode == PdfSaveMode.FULL, { mode = PdfSaveMode.FULL },
                       { Text("Full rewrite") }, Modifier.padding(end = 8.dp))
            FilterChip(mode == PdfSaveMode.INCREMENTAL, { mode = PdfSaveMode.INCREMENTAL },
                       { Text("Incremental") })
        }
        if (mode == PdfSaveMode.INCREMENTAL) {
            Text("Incremental keeps the original bytes and existing signatures, but does not " +
                 "persist annotations created in this session.",
                 style = MaterialTheme.typography.bodySmall,
                 color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.height(16.dp))
        Button(onClick = {
            scope.launch {
                status = try {
                    val document = store.document ?: return@launch
                    val bytes = document.toByteArray(mode)
                    val file = File(context.cacheDir, "pdfiumkit-export.pdf")
                    file.writeBytes(bytes)
                    "Exported ${bytes.size / 1024} KB to ${file.name}"
                } catch (e: PdfError) {
                    "Export failed — ${e.message}"
                }
            }
        }) { Text("Export") }
        Spacer(Modifier.height(16.dp))
        Text(status, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
