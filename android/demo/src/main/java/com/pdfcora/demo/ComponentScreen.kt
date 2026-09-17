package com.pdfcora.demo

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import com.pdfcora.ui.PdfToolbarConfiguration
import com.pdfcora.ui.PdfToolbarItem
import com.pdfcora.ui.PdfViewerTheme
import com.pdfcora.ui.PdfViewerView

/**
 * The same editor as [EditorScreen], built from the SDK's own component instead of by
 * hand — which is the point of the component existing.
 *
 * [EditorScreen] stays alongside it deliberately: it is the worked example of driving
 * the headless viewer yourself, and it proves the two layers are really separable.
 */
@Composable
fun ComponentScreen(store: DocumentStore) {
    val document = store.document
    if (document == null) {
        Text("No document loaded.")
        return
    }

    // A custom toolbar item, to show an app can add its own. Content is platform-native
    // on purpose: this is an ImageVector.
    val toolbar = PdfToolbarConfiguration(
        PdfToolbarConfiguration.Default.items + PdfToolbarItem.Custom(
            id = "custom-share", label = "Share", image = Icons.Filled.Share,
        ) { /* an app-defined action; the component knows nothing about it */ },
    )

    PdfViewerView(
        document = document,
        modifier = Modifier.fillMaxSize(),
        toolbar = toolbar,
        theme = PdfViewerTheme.Light,
    )
}
