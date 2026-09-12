package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Measures how far a hung render spreads. Each document owns a single-thread
 * dispatcher, so a hang should cost exactly that document — and one thread, for good.
 *
 * The hung coroutines are never reclaimed; they end with the test process.
 */
@RunWith(AndroidJUnit4::class)
class BlastRadiusTest {
    private fun asset(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { it.readBytes() }

    @Test
    fun hangsDoNotStarveOtherDocuments() = runTest {
        // Real dispatchers and real time: runTest's virtual clock would skip the delays
        // that let the hangs actually start.
        withContext(Dispatchers.Default) {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val cores = Runtime.getRuntime().availableProcessors()
            android.util.Log.i("pdfiumkit", "BLAST: cores=$cores")

            repeat(cores + 2) { i ->
                val doc = PdfDocument.open(asset("hang-probe.pdf"))
                val page = doc.page(0)
                scope.launch { runCatching { page.render(width = 80) } }
                delay(200)
                android.util.Log.i("pdfiumkit", "BLAST: hang ${i + 1} started")
            }

            var ticks = 0
            repeat(10) { delay(100); ticks++ }
            assertEquals("unrelated coroutines were starved", 10, ticks)

            PdfDocument.open(asset("corpus/hello_world.pdf")).use { other ->
                assertEquals(120, other.page(0).render(width = 120).width)
            }
            android.util.Log.i("pdfiumkit", "BLAST: other document STILL renders after ${cores + 2} hangs")
        }
    }
}
