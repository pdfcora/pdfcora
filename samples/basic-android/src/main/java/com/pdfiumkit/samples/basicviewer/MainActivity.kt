package com.pdfiumkit.samples.basicviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.ui.PdfViewerView

/** Opens the bundled PDF and shows it in the SDK's viewer with its default toolbar. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Without a license key the SDK works fully, but pages carry a "PdfiumKit trial"
        // watermark. With a key issued for this app's package name, set it before opening
        // documents (an app would do this in Application.onCreate):
        // com.pdfiumkit.license.PdfLicense.setKey(this, "pk1.…")
        setContent {
            var document by remember { mutableStateOf<PdfDocument?>(null) }
            LaunchedEffect(Unit) {
                document = PdfDocument.open(assets.open("sample.pdf").use { it.readBytes() })
            }
            DisposableEffect(document) {
                // Capture this effect's document: reading the state in onDispose would see
                // the next one, and close the document that was just opened.
                val opened = document
                onDispose { opened?.close() }
            }
            document?.let { PdfViewerView(it, Modifier.fillMaxSize()) }
        }
    }
}
