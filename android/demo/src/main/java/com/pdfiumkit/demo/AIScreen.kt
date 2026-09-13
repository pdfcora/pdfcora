package com.pdfiumkit.demo

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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.pdfiumkit.ai.PdfAiAvailability
import com.pdfiumkit.ai.PdfAiOutcome
import com.pdfiumkit.ai.PdfAiProvider
import com.pdfiumkit.ai.PdfAiResponse
import com.pdfiumkit.ai.PdfiumAI
import com.pdfiumkit.ai.PdfiumAIOptions
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL

/**
 * What a user sees when a feature cannot run — which on most devices today is what they
 * will see.
 *
 * The stub feature exists precisely so this path can be exercised before any real
 * feature does.
 */
@Composable
fun AIScreen(store: DocumentStore) {
    var endpoint by remember { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // A provider is the integrator's to supply. Document content reaches it only
    // because the host configured it (PRV-4).
    val provider: PdfAiProvider? = if (endpoint.isBlank()) null else PdfAiProvider { request ->
        val connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
        }
        connection.outputStream.use {
            it.write("""{"prompt":"${request.prompt}"}""".toByteArray())
        }
        check(connection.responseCode == 200) { "provider returned ${connection.responseCode}" }
        PdfAiResponse(connection.inputStream.bufferedReader().readText())
    }

    val document = store.document
    val ai = document?.let { PdfiumAI(it, PdfiumAIOptions(provider = provider)) }
    // AVL-3: read per composition rather than caching at launch.
    val availability = ai?.stub?.availability()

    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Availability", style = MaterialTheme.typography.titleMedium)
        Row(Modifier.fillMaxWidth()) {
            Text(availability?.let { describe(it) } ?: "no document loaded")
        }
        Text(
            "Android has no on-device route wired up yet — ML Kit arrives with the "
                + "feature that needs it — so without a provider this is the honest answer "
                + "rather than a failure.",
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

        Text("Stub feature", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                scope.launch {
                    // AVL-4: the host asks. Nothing here starts a download on its own.
                    val after = ai?.stub?.prepare { status = "preparing… ${(it * 100).toInt()}%" }
                    status = "prepare finished — ${after?.let { describe(it) } ?: "no document"}"
                }
            }) { Text("Prepare") }

            Button(onClick = {
                scope.launch {
                    status = when (val outcome = ai?.stub?.run()) {
                        is PdfAiOutcome.Answered ->
                            "answered \"${outcome.result.value}\" via ${outcome.result.source}"
                        is PdfAiOutcome.NotAvailable -> "unavailable — ${describe(outcome.state)}"
                        null -> "no document loaded"
                    }
                }
            }) { Text("Run") }
        }

        status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        Text(
            "Phase 0 ships no AI feature. The stub does nothing except report whether it "
                + "could, which is what makes this screen testable.",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private fun describe(availability: PdfAiAvailability): String = when (availability) {
    is PdfAiAvailability.Available -> "available"
    is PdfAiAvailability.Downloadable -> "downloadable"
    is PdfAiAvailability.Downloading ->
        availability.progress?.let { "downloading ${(it * 100).toInt()}%" } ?: "downloading"
    is PdfAiAvailability.Unavailable -> "unavailable — ${availability.reason}"
}
