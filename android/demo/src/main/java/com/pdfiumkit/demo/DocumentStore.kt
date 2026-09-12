package com.pdfiumkit.demo

import androidx.compose.foundation.clickable
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfError

/** Holds the document every screen works against, and the bundled samples. */
@Stable
class DocumentStore(
    private val openAsset: (String) -> ByteArray,
    private val scope: CoroutineScope,
) {
    data class Sample(val title: String, val asset: String)

    companion object {
        val SAMPLES = listOf(
            Sample("Hello World", "sample.pdf"),
            Sample("Text Form", "form.pdf"),
            Sample("Annotated", "annotated.pdf"),
        )
    }

    var document by mutableStateOf<PdfDocument?>(null)
        private set
    var pageCount by mutableIntStateOf(0)
        private set
    var title by mutableStateOf("No document")
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** Bumped after every edit so screens recompose against fresh document state. */
    var revision by mutableIntStateOf(0)
        private set

    fun load(sample: Sample) {
        scope.launch {
            try {
                val opened = PdfDocument.open(openAsset(sample.asset))
                document?.close()
                document = opened
                pageCount = opened.pageCount()
                title = sample.title
                error = null
                revision++
            } catch (e: PdfError) {
                error = e.message
            } catch (e: Exception) {
                error = e.message ?: "failed to open document"
            }
        }
    }

    /** Runs an edit, then signals screens to reload. */
    fun edit(block: suspend (PdfDocument) -> Unit) {
        val current = document ?: return
        scope.launch {
            try {
                block(current)
                revision++
            } catch (e: PdfError) {
                error = e.message
            }
        }
    }
}

@Composable
fun rememberDocumentStore(): DocumentStore {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    return remember {
        DocumentStore(
            openAsset = { name -> context.assets.open(name).use { it.readBytes() } },
            scope = scope,
        )
    }
}

/** Shared row-tap modifier, so list screens stay uncluttered. */
fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)
