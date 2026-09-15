package com.pdfiumkit.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pdfiumkit.view.PdfMark
import com.pdfiumkit.view.PdfMarkState

/**
 * Puts the viewer in review mode: marks over the page that a tap cycles, and a bar that
 * always shows [notice]. The component does not apply anything; [onApply] does.
 */
class PdfReviewConfiguration(
    val marks: List<PdfMark>,
    val notice: String,
    val applyLabel: String = "Apply",
    val onApply: (List<String>) -> Unit,
    val onCancel: (() -> Unit)? = null,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PdfReviewBar(
    configuration: PdfReviewConfiguration,
    marks: List<PdfMark>,
    theme: PdfViewerTheme,
    setAll: (PdfMarkState) -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(theme.toolbarBackground).padding(8.dp)) {
        Text(configuration.notice, style = MaterialTheme.typography.bodySmall,
             modifier = Modifier.semantics { contentDescription = "review-notice" })
        // Wraps rather than squeezing: at large font scales a single row pushed the counts to zero
        // width and Cancel off the edge.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.Center) {
            val accepted = marks.count { it.state == PdfMarkState.ACCEPTED }
            val pending = marks.count { it.state == PdfMarkState.PENDING }
            Text("$accepted accepted · $pending pending", style = MaterialTheme.typography.bodySmall,
                 modifier = Modifier.align(Alignment.CenterVertically).padding(end = 8.dp)
                     .semantics { contentDescription = "review-counts" })
            TextButton({ setAll(PdfMarkState.ACCEPTED) }, Modifier.semantics { contentDescription = "review-accept-all" }) { Text("Accept all") }
            TextButton({ setAll(PdfMarkState.REJECTED) }, Modifier.semantics { contentDescription = "review-reject-all" }) { Text("Reject all") }
            TextButton({ configuration.onApply(marks.filter { it.state == PdfMarkState.ACCEPTED }.map { it.id }) },
                       Modifier.semantics { contentDescription = "review-apply" }) { Text(configuration.applyLabel) }
            configuration.onCancel?.let { cancel ->
                TextButton(cancel, Modifier.semantics { contentDescription = "review-cancel" }) { Text("Cancel") }
            }
        }
    }
}
