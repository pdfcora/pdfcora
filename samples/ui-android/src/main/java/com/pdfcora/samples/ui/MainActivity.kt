package com.pdfcora.samples.ui

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
import com.pdfcora.PdfDocument
import com.pdfcora.view.PdfTool
import com.pdfcora.ui.PdfToolbarConfiguration
import com.pdfcora.ui.PdfToolbarItem
import com.pdfcora.ui.PdfViewerTheme
import com.pdfcora.ui.PdfViewerView
import androidx.compose.ui.graphics.Color
import android.widget.Toast

/**
 * The viewer component with a hand-picked toolbar, an app accent colour and a save
 * handler. `PdfToolbarConfiguration.Default` and `.Viewing` are ready-made.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
            document?.let {
                PdfViewerView(
                    it,
                    Modifier.fillMaxSize(),
                    toolbar = PdfToolbarConfiguration(listOf(
                        PdfToolbarItem.PageBack, PdfToolbarItem.PageForward, PdfToolbarItem.Divider,
                        PdfToolbarItem.Tool(PdfTool.HIGHLIGHT), PdfToolbarItem.Tool(PdfTool.NOTE),
                        PdfToolbarItem.Divider,
                        PdfToolbarItem.ZoomOut, PdfToolbarItem.FitWidth, PdfToolbarItem.ZoomIn,
                        PdfToolbarItem.Spacer, PdfToolbarItem.Save,
                    )),
                    theme = PdfViewerTheme.Light.copy(accent = Color(0xFF7C3AED)),
                    // The viewer never writes a file; it hands the app the bytes it saved.
                    onSave = { bytes ->
                        Toast.makeText(this, "Saved ${bytes.size / 1024} KB", Toast.LENGTH_SHORT).show()
                    },
                )
            }
        }
    }
}
