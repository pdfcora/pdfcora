package com.pdfcora.samples.ai

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pdfcora.PdfDocument
import com.pdfcora.ai.PdfAiOutcome
import com.pdfcora.ai.PdfSummaryStyle
import com.pdfcora.ai.PdfAI
import com.pdfcora.ai.PdfAIOptions
import com.pdfcora.ai.redaction.PdfRedactionReview
import kotlinx.coroutines.launch

/**
 * Summarise a document with ML Kit's on-device model, and propose redactions a person
 * accepts before anything is changed.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val scope = rememberCoroutineScope()
            var ai by remember { mutableStateOf<PdfAI?>(null) }
            var availability by remember { mutableStateOf("…") }
            var summary by remember { mutableStateOf("") }
            var review by remember { mutableStateOf<PdfRedactionReview?>(null) }
            val accepted = remember { mutableStateListOf<String>() }
            var applied by remember { mutableStateOf("") }

            LaunchedEffect(Unit) {
                val document = PdfDocument.open(assets.open("sample.pdf").use { it.readBytes() })
                // `context` is what lets the SDK reach ML Kit; without it summaries fall
                // back to a custom provider, which an app passes as `provider = …`.
                val opened = PdfAI(document, PdfAIOptions(context = applicationContext))
                ai = opened
                // AVL-2: availability is reported per feature and re-read on every call.
                // The SDK never downloads a model itself — that is `prepare()`, below.
                availability = "Summaries: ${opened.summaries.availability()}"
            }

            MaterialTheme {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                    Text(availability, style = MaterialTheme.typography.bodySmall)

                    Button(onClick = {
                        scope.launch {
                            val engine = ai ?: return@launch
                            summary = "Working…"
                            // The host asks for the download; AICore also refuses to run
                            // while the app is in the background or the screen is off.
                            engine.summaries.prepare()
                            summary = when (val out = engine.summaries.summarize(style = PdfSummaryStyle.KEY_POINTS)) {
                                is PdfAiOutcome.Answered -> "${out.result.value.text}\n\n— ${out.result.source}"
                                is PdfAiOutcome.NotAvailable -> "No summary: ${out.state}"
                            }
                        }
                    }, Modifier.padding(top = 8.dp)) { Text("Summarise") }

                    if (summary.isNotEmpty()) Text(summary, style = MaterialTheme.typography.bodySmall)

                    Button(onClick = {
                        scope.launch {
                            val found = ai?.redactions?.suggest() ?: return@launch
                            accepted.clear()
                            accepted.addAll(found.suggestions.map { it.id })
                            review = found
                        }
                    }, Modifier.padding(top = 16.dp)) { Text("Find personal data") }

                    review?.let { found ->
                        // RED-4: the notice goes with the suggestions, every time.
                        Text(found.notice, style = MaterialTheme.typography.bodySmall,
                             modifier = Modifier.padding(vertical = 8.dp))
                        for (suggestion in found.suggestions) {
                            Row(Modifier.fillMaxWidth()) {
                                Checkbox(
                                    checked = suggestion.id in accepted,
                                    onCheckedChange = { on ->
                                        if (on) accepted.add(suggestion.id) else accepted.remove(suggestion.id)
                                    },
                                )
                                Text("${suggestion.category}: ${suggestion.text}",
                                     style = MaterialTheme.typography.bodySmall)
                            }
                        }
                        Button(onClick = {
                            scope.launch {
                                // Redaction removes the content itself: this is about the
                                // saved bytes, not a black box drawn over the page.
                                val result = found.apply(accepted.toList())
                                applied = "Removed ${result.report.textObjects}, rewrote " +
                                    "${result.report.textObjectsSplit}; still findable: ${result.remaining.size}"
                            }
                        }) { Text("Redact the ticked items") }
                        if (applied.isNotEmpty()) Text(applied, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
