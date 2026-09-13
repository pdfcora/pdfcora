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
import com.pdfiumkit.cms.PdfSignatureValidity
import com.pdfiumkit.cms.PdfVerifyOptions
import com.pdfiumkit.signatures
import com.pdfiumkit.verify
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
    /** Two independent answers per signature, keyed by index. */
    var verdicts by remember { mutableStateOf<Map<Int, Pair<Boolean, PdfSignatureValidity>>>(emptyMap()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(store.revision, store.document) {
        val document = store.document ?: return@LaunchedEffect
        runCatching {
            val found = document.signatures()
            // Two deliberately separate questions. Verifying without anchors answers
            // trust and, when it fails, hands back the chain; re-verifying with that
            // chain's own root as an anchor then isolates the cryptography.
            val judged = found.associate { signature ->
                val trust = document.verify(signature)
                val intact = when (trust) {
                    is PdfSignatureValidity.Valid -> true
                    is PdfSignatureValidity.Untrusted -> {
                        val root = trust.chain.lastOrNull()?.der
                        document.verify(
                            signature,
                            PdfVerifyOptions(trustAnchors = listOfNotNull(root)),
                        ) is PdfSignatureValidity.Valid
                    }
                    else -> false
                }
                signature.index to (intact to trust)
            }
            found to judged
        }
            .onSuccess { (found, judged) -> signatures = found; verdicts = judged; error = null }
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
            verdicts[signature.index]?.let { (intact, trust) ->
                Spacer(Modifier.height(10.dp))
                VerificationBanner(intact, trust)
            }
        }

        if (signatures.isNotEmpty()) {
            item {
                Spacer(Modifier.height(20.dp))
                Text(
                    "Revocation is not checked, so a valid result does not mean the " +
                        "certificate is still in good standing.",
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

/**
 * Shown as two lines so neither answer can be mistaken for the other: a signature can be
 * cryptographically intact and still untrusted.
 */
@Composable
private fun VerificationBanner(intact: Boolean, trust: PdfSignatureValidity) {
    val trusted = trust is PdfSignatureValidity.Valid
    Column {
        Verdict(
            ok = intact,
            text = if (intact) "Integrity: the signed bytes are unchanged." else "Integrity: FAILED.",
            id = if (intact) "integrity-ok" else "integrity-failed",
        )
        Spacer(Modifier.height(6.dp))
        Verdict(
            ok = trusted,
            text = if (trusted) {
                "Trust: the chain reaches a trusted issuer."
            } else {
                "Trust: not established — ${reasonFor(trust)}."
            },
            id = if (trusted) "trust-ok" else "trust-unestablished",
        )
    }
}

@Composable
private fun Verdict(ok: Boolean, text: String, id: String) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = if (ok) {
                MaterialTheme.colorScheme.secondaryContainer
            } else {
                MaterialTheme.colorScheme.errorContainer
            },
        ),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = id },
    ) {
        Text(text, Modifier.padding(10.dp), style = MaterialTheme.typography.bodySmall)
    }
}

private fun reasonFor(verdict: PdfSignatureValidity): String = when (verdict) {
    is PdfSignatureValidity.Untrusted -> verdict.reason
    is PdfSignatureValidity.DigestMismatch -> "the bytes changed after signing"
    is PdfSignatureValidity.Expired -> "the certificate expired on ${verdict.at}"
    is PdfSignatureValidity.Malformed -> verdict.reason
    is PdfSignatureValidity.Unsupported -> "unsupported type ${verdict.subFilter}"
    is PdfSignatureValidity.Valid -> ""
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
