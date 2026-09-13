package com.pdfiumkit.demo

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pdfiumkit.PdfSignature
import com.pdfiumkit.signatures
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Lists the signatures a document carries.
 *
 * The coverage banner is deliberately prominent. A signature can be cryptographically
 * intact and still cover only part of the file; presenting "signed" without that
 * distinction is how an amended document passes review.
 */
@Composable
fun SignaturesScreen(store: DocumentStore) {
    var signatures by remember { mutableStateOf<List<PdfSignature>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(store.revision, store.document) {
        val document = store.document ?: return@LaunchedEffect
        runCatching { document.signatures() }
            .onSuccess { signatures = it; error = null }
            .onFailure { error = it.message }
    }

    LazyColumn(Modifier.fillMaxSize().padding(16.dp)) {
        error?.let { message ->
            item { Text(message, color = MaterialTheme.colorScheme.error) }
        }
        if (error == null && signatures.isEmpty()) {
            item {
                Text("This document carries no signatures.",
                     color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        items(signatures.size) { index ->
            val signature = signatures[index]
            Text("Signature ${signature.index + 1}",
                 style = MaterialTheme.typography.titleMedium,
                 modifier = Modifier.padding(top = if (index == 0) 0.dp else 24.dp))
            Spacer(Modifier.height(8.dp))
            CoverageBanner(signature.coversWholeDocument)
            Spacer(Modifier.height(8.dp))
            Field("Type", signature.subFilter ?: "—")
            Field("Reason", signature.reason ?: "—")
            Field("Claimed signing time", formatUtc(signature.signingTime?.time))
            Field("Signed ranges", signature.byteRange.joinToString(", "))
            Field("PKCS#7 size", "${signature.contents.size} bytes")
        }

        if (signatures.isNotEmpty()) {
            item {
                Spacer(Modifier.height(20.dp))
                Text(
                    "Not verified. This SDK reads signatures; it does not yet check them " +
                        "cryptographically or validate the certificate chain.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun CoverageBanner(coversWholeDocument: Boolean) {
    val text = if (coversWholeDocument) {
        "Covers the whole file."
    } else {
        "Covers only part of the file — content was added after signing and is NOT protected."
    }
    val colors = if (coversWholeDocument) {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    } else {
        CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    }
    Card(
        colors = colors,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = if (coversWholeDocument) "coverage-whole" else "coverage-partial" },
    ) {
        Text(text, Modifier.padding(12.dp), fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun Field(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.Top) {
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, Modifier.weight(1.4f))
    }
}

private fun formatUtc(millis: Long?): String {
    if (millis == null) return "—"
    val format = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(millis) + " UTC"
}
