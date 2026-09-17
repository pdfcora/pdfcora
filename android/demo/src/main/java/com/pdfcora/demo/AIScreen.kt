package com.pdfcora.demo

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.pdfcora.ai.PdfAiAvailability
import com.pdfcora.ai.PdfAiOutcome
import com.pdfcora.ai.PdfAiProvider
import com.pdfcora.ai.PdfAiResponse
import com.pdfcora.ai.PdfAnswer
import com.pdfcora.ai.PdfSummaryStyle
import com.pdfcora.ai.PdfAI
import com.pdfcora.ai.PdfAIOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Grounded answers and summaries, and what a user sees when they cannot run — which on
 * many devices today is what they will see.
 */
@Composable
fun AIScreen(store: DocumentStore) {
    var endpoint by remember { mutableStateOf("") }
    var question by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    var summaries by remember { mutableStateOf<PdfAiAvailability?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current.applicationContext

    // A provider is the integrator's to supply. Document content reaches it only
    // because the host configured it (PRV-4).
    val provider: PdfAiProvider? = if (endpoint.isBlank()) null else PdfAiProvider { request ->
        withContext(Dispatchers.IO) {
            val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            connection.outputStream.use {
                it.write(JSONObject().put("prompt", request.prompt).toString().toByteArray())
            }
            check(connection.responseCode == 200) { "provider returned ${connection.responseCode}" }
            val body = connection.inputStream.bufferedReader().readText()
            PdfAiResponse(JSONObject(body).optString("text"))
        }
    }

    val document = store.document
    val ai = document?.let { PdfAI(it, PdfAIOptions(provider = provider, context = context)) }
    // AVL-3: read per composition rather than caching at launch.
    val answers = ai?.answers?.availability()
    LaunchedEffect(ai) { summaries = ai?.summaries?.availability() }

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Availability", style = MaterialTheme.typography.titleMedium)
        Text("Answers: " + (answers?.let { describe(it) } ?: "no document loaded"))
        Text("Summaries: " + (summaries?.let { describe(it) } ?: "checking…"))
        Text(
            "Answers need a provider: Android's on-device prompt API is still alpha. "
                + "Summaries run on-device through ML Kit where AICore is available.",
            style = MaterialTheme.typography.bodySmall,
        )

        Text("Custom provider", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = endpoint,
            onValueChange = { endpoint = it },
            label = { Text("https://your-server/generate") },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "The SDK ships no model and no cloud account.",
            style = MaterialTheme.typography.bodySmall,
        )

        Text("Try it", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            value = question,
            onValueChange = { question = it },
            label = { Text("What's the notice period?") },
            modifier = Modifier.fillMaxWidth(),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                scope.launch {
                    status = when (val outcome = ai?.answers?.ask(question.ifBlank { "What's the notice period?" })) {
                        is PdfAiOutcome.Answered -> when (val answer = outcome.result.value) {
                            is PdfAnswer.Answered -> (listOf(answer.text + if (answer.grounded) "" else " (not grounded)")
                                + answer.citations.map { "page ${it.pageIndex + 1}: “${it.quote}”" }
                                + "via ${outcome.result.source}").joinToString("\n")
                            is PdfAnswer.NotFound -> "not found in the document"
                        }
                        is PdfAiOutcome.NotAvailable -> "unavailable — ${describe(outcome.state)}"
                        null -> "no document loaded"
                    }
                }
            }) { Text("Ask") }

            Button(onClick = {
                scope.launch {
                    // AVL-4: the host asks. Nothing here starts a download on its own.
                    ai?.summaries?.prepare { status = "preparing… ${(it * 100).toInt()}%" }
                    status = when (val outcome = ai?.summaries?.summarize(style = PdfSummaryStyle.KEY_POINTS)) {
                        is PdfAiOutcome.Answered -> "${outcome.result.value.text}\nvia ${outcome.result.source}"
                        is PdfAiOutcome.NotAvailable -> "unavailable — ${describe(outcome.state)}"
                        null -> "no document loaded"
                    }
                }
            }) { Text("Summarise") }
        }

        status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

private fun describe(availability: PdfAiAvailability): String = when (availability) {
    is PdfAiAvailability.Available -> "available"
    is PdfAiAvailability.Downloadable -> "downloadable"
    is PdfAiAvailability.Downloading ->
        availability.progress?.let { "downloading ${(it * 100).toInt()}%" } ?: "downloading"
    is PdfAiAvailability.Unavailable -> "unavailable — ${availability.reason}"
}
