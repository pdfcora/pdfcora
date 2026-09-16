package com.pdfiumkit.samples.core

import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.dp
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.formFields
import com.pdfiumkit.signatures

/**
 * The core API with no UI component: open a PDF, read its facts, get page text, search,
 * list form fields, render a page, save.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            var facts by remember { mutableStateOf("Opening…") }
            var text by remember { mutableStateOf("") }
            var page by remember { mutableStateOf<Bitmap?>(null) }

            LaunchedEffect(Unit) {
                // Every call is suspending and runs on the SDK's own dispatcher, so the
                // UI thread is never blocked.
                val document = PdfDocument.open(assets.open("sample.pdf").use { it.readBytes() })
                val first = document.page(0)
                facts = buildString {
                    appendLine("Pages: ${document.pageCount()}")
                    appendLine("Title: ${document.metadata().title ?: "(none)"}")
                    appendLine("Signatures: ${document.signatures().size}")
                    appendLine("Matches for \"the\" on page 1: ${first.text.search("the").size}")
                    appendLine("Form fields on page 1: ${first.formFields().size}")
                    appendLine("Saved size: ${document.toByteArray().size} bytes")
                }
                text = first.text.string().take(600)
                page = first.render(width = 900)
                // The document owns native memory; an app closes it when done with it.
                document.close()
            }

            MaterialTheme {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                    Text(facts, style = MaterialTheme.typography.bodyMedium)
                    Text("\nPage 1 text\n", style = MaterialTheme.typography.titleSmall)
                    Text(text, style = MaterialTheme.typography.bodySmall)
                    page?.let {
                        Text("\nPage 1 rendered\n", style = MaterialTheme.typography.titleSmall)
                        Image(it.asImageBitmap(), contentDescription = "Page 1", Modifier.fillMaxWidth())
                    }
                }
            }
        }
    }
}
