package com.pdfcora.demo

import android.util.Log
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.pdfcora.PdfDocument
import com.pdfcora.ai.PdfAI
import com.pdfcora.ai.PdfAIOptions

/**
 * Measures ML Kit's on-device image description against the tagged fixture. AICore refuses
 * inference from a background process, so this runs from a resumed activity rather than an
 * instrumented test; `adb shell am start -e measure alt-text …` opens it and the results are
 * logged as `MEASURE` lines.
 */
@Composable
fun MeasureAltTextScreen() {
    val context = LocalContext.current.applicationContext
    var log by remember { mutableStateOf("running…") }

    LaunchedEffect(Unit) {
        val lines = StringBuilder()
        fun say(line: String) {
            Log.i("MEASURE", line)
            lines.appendLine(line)
            log = lines.toString()
        }
        try {
            val document = PdfDocument.open(context.assets.open("tagged.pdf").use { it.readBytes() })
            val ai = PdfAI(document, PdfAIOptions(context = context))
            say("availability before prepare: ${ai.altText.availability()}")
            val ready = ai.altText.prepare { say("download ${(it * 100).toInt()}%") }
            say("availability after prepare: $ready")
            val started = System.currentTimeMillis()
            val review = ai.altText.suggest()
            say("suggest took ${System.currentTimeMillis() - started} ms, modelUsed=${review.modelUsed}, items=${review.items.size}")
            for (item in review.items) {
                say("item ${item.id} kind=${item.kind} source=${item.source} text=${item.text.ifEmpty { "(none)" }}")
            }
            document.close()
        } catch (e: Throwable) {
            say("failed: ${e::class.java.simpleName}: ${e.message}")
        }
        say("done")
    }

    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Text(log, style = MaterialTheme.typography.bodySmall)
    }
}
