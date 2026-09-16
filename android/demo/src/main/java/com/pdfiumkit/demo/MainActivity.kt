package com.pdfiumkit.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pdfiumkit.PdfDocument

/** Every screen the demo offers; each is a self-contained example of one API area. */
enum class Demo(val title: String, val detail: String) {
    EDITOR("Editor", "Fill forms and annotate on the page"),
    VIEWER("Viewer", "Render pages, pan and zoom"),
    SEARCH("Search", "Find text and highlight hits"),
    OUTLINE("Outline", "Bookmarks and destinations"),
    THUMBNAILS("Thumbnails", "Grid of rendered pages"),
    ANNOTATIONS("Annotations", "Read, draw ink, add notes"),
    FORMS("Forms", "Fill fields, toggle checkboxes"),
    TEXT("Text", "Extract and copy page text"),
    SIGNATURES("Signatures", "Read signatures and their coverage"),
    INFO("Document Info", "Metadata, permissions, attachments"),
    PAGE_OPS("Page Operations", "Rotate pages"),
    EXPORT("Export", "Save edits and share"),
    AI("AI", "On-device availability and providers"),
    COMPONENT("Component", "The SDK's own viewer, toolbar and theme"),
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val measure = intent?.getStringExtra("measure")
        setContent {
            MaterialTheme { if (measure == "alt-text") MeasureAltTextScreen() else App() }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun App() {
    val store = rememberDocumentStore()
    var current by remember { mutableStateOf<Demo?>(null) }

    LaunchedEffect(Unit) { store.load(DocumentStore.SAMPLES.first()) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(current?.title ?: "PdfiumKit") },
                navigationIcon = {
                    if (current != null) {
                        IconButton(onClick = { current = null }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                }
            )
        }
    ) { padding ->
        Box(Modifier.padding(padding)) {
            when (val screen = current) {
                null -> HomeScreen(store) { current = it }
                Demo.EDITOR -> EditorScreen(store)
                Demo.VIEWER -> ViewerScreen(store)
                Demo.SEARCH -> SearchScreen(store)
                Demo.OUTLINE -> OutlineScreen(store)
                Demo.THUMBNAILS -> ThumbnailsScreen(store)
                Demo.ANNOTATIONS -> AnnotationsScreen(store)
                Demo.FORMS -> FormsScreen(store)
                Demo.TEXT -> TextScreen(store)
                Demo.SIGNATURES -> SignaturesScreen(store)
                Demo.INFO -> InfoScreen(store)
                Demo.PAGE_OPS -> PageOpsScreen(store)
                Demo.EXPORT -> ExportScreen(store)
                Demo.AI -> AIScreen(store)
                Demo.COMPONENT -> ComponentScreen(store)
            }
        }
    }
}

@Composable
private fun HomeScreen(store: DocumentStore, onOpen: (Demo) -> Unit) {
    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Text("Document", Modifier.padding(16.dp, 16.dp, 16.dp, 4.dp),
                 style = MaterialTheme.typography.labelLarge)
        }
        items(DocumentStore.SAMPLES) { sample ->
            ListItem(
                headlineContent = { Text(sample.title) },
                trailingContent = { if (store.title == sample.title) Text("✓") },
                modifier = Modifier.clickableRow { store.load(sample) }
            )
        }
        store.error?.let { message ->
            item {
                Text(message, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
            }
        }
        item {
            Text("${store.title} — ${store.pageCount} page${if (store.pageCount == 1) "" else "s"}",
                 Modifier.padding(16.dp, 24.dp, 16.dp, 4.dp),
                 style = MaterialTheme.typography.labelLarge)
        }
        items(Demo.entries) { demo ->
            ListItem(
                headlineContent = { Text(demo.title, fontWeight = FontWeight.Medium) },
                supportingContent = { Text(demo.detail) },
                modifier = Modifier.clickableRow {
                    if (store.document != null) onOpen(demo)
                }
            )
            HorizontalDivider()
        }
    }
}
