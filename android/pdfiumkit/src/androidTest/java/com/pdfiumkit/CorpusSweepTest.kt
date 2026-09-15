package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The Android twin of `conformance/robustness.mjs`: runs every document in a corpus through
 * the SDK and records what happened, so a malformed file shows up as a typed error rather
 * than a crash.
 *
 * Driven by `scripts/sweep-android.sh`, which pushes the corpus to the device and passes
 * `sweepCorpus` and `sweepStart`. A crash kills this process, so the test records the index
 * it started before each document, and the script resumes after it. Skipped without a
 * corpus, so it costs nothing in the normal gate.
 */
@RunWith(AndroidJUnit4::class)
class CorpusSweepTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    /** Runs a shell command as the shell user, which can read the pushed corpus. */
    private fun shell(command: String): ByteArray =
        instrumentation.uiAutomation.executeShellCommand(command).let { fd ->
            java.io.FileInputStream(fd.fileDescriptor).use { it.readBytes() }.also { fd.close() }
        }

    @Test
    fun sweep() = runBlocking {
        val corpus = InstrumentationRegistry.getArguments().getString("sweepCorpus")
        assumeTrue("pass sweepCorpus; see scripts/sweep-android.sh", corpus != null)
        val start = InstrumentationRegistry.getArguments().getString("sweepStart")?.toInt() ?: 0
        val files = String(shell("find $corpus -name *.pdf")).lines().filter { it.isNotBlank() }
            .map { it.removePrefix("$corpus/") }.sorted()
        val dir = instrumentation.targetContext.filesDir
        val results = File(dir, "sweep.jsonl")
        // A hung render holds the engine; calls behind it then fail fast instead of waiting.
        PdfDocument.engineTimeoutMillis = 10_000

        for (index in start until files.size) {
            File(dir, "sweep.started").writeText("$index")
            val outcome = exercise(shell("cat $corpus/${files[index]}"))
            results.appendText(outcome.put("index", index).put("file", files[index]).toString() + "\n")
            // The engine is wedged for the rest of this process; the script starts a fresh one.
            if (outcome.getString("outcome") == "timeout") return@runBlocking
        }
    }

    /**
     * Everything `robustness.mjs` does, under a deadline. Awaited from outside rather than
     * wrapped in withTimeout, because a call that hangs inside PDFium never returns to be
     * cancelled.
     */
    private suspend fun exercise(bytes: ByteArray): JSONObject {
        val work = CoroutineScope(Dispatchers.Default).async { exerciseAll(bytes) }
        return withTimeoutOrNull(20_000) { work.await() }
            ?: JSONObject().put("outcome", "timeout").put("code", "20s")
    }

    private suspend fun exerciseAll(bytes: ByteArray): JSONObject {
        val document = try {
            PdfDocument.open(bytes)
        } catch (e: PdfError) {
            return JSONObject().put("outcome", "rejected").put("code", code(e))
        } catch (e: Exception) {
            return JSONObject().put("outcome", "untyped-throw").put("code", e.toString())
        }
        return try {
            val pageCount = document.pageCount()
            for (index in 0 until minOf(pageCount, 3)) {
                val page = document.page(index)
                page.size()
                page.render(width = 80)
                page.text.string()
                page.text.characterCount()
                page.text.search("a")
                page.annotations()
                page.formFields()
            }
            document.metadata()
            document.permissions()
            document.attachments()
            document.outline()
            document.toByteArray()
            JSONObject().put("outcome", "ok").put("pageCount", pageCount)
        } catch (e: PdfError) {
            JSONObject().put("outcome", if (e is PdfError.EngineUnresponsive) "timeout" else "typed-error").put("code", code(e))
        } catch (e: Exception) {
            JSONObject().put("outcome", "untyped-throw").put("code", e.toString())
        } finally {
            document.close()
        }
    }

    /** The web SDK's error code for the same failure, so the reports can be compared. */
    private fun code(error: PdfError): String = error::class.simpleName!!.replaceFirstChar { it.lowercase() }
}
