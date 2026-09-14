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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * How far a genuinely hung render spreads.
 *
 * `hang-probe.pdf` never returns from PDFium's render. Every PDFium call shares one engine
 * thread, so without the watchdog this blocks every document forever; with it, calls
 * behind the hang fail fast with [PdfError.EngineUnresponsive].
 *
 * The render spins a core for the life of the process and the engine stays unresponsive,
 * so this runs in its own pass; see [LeaksNativeThreads].
 */
@RunWith(AndroidJUnit4::class)
@LeaksNativeThreads
class BlastRadiusTest {
    private fun asset(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { it.readBytes() }

    @Test
    fun aHungRenderFailsOtherDocumentsFastInsteadOfBlockingThem() = runTest {
        // Real dispatchers and real time: runTest's virtual clock would skip the delays
        // that let the hang actually start.
        withContext(Dispatchers.Default) {
            PdfDocument.engineTimeoutMillis = 1_000
            val helloWorld = asset("corpus/hello_world.pdf")
            val other = PdfDocument.open(helloWorld)
            val page = PdfDocument.open(asset("hang-probe.pdf")).page(0)

            CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
                runCatching { page.render(width = 80) }
            }
            delay(2_000)

            // Coroutines unrelated to the engine keep running: the wedge is one thread.
            var ticks = 0
            repeat(10) { delay(100); ticks++ }
            assertEquals("unrelated coroutines were starved", 10, ticks)

            val started = System.nanoTime()
            try {
                other.page(0).render(width = 120)
                fail("a render behind the hung one completed")
            } catch (e: PdfError.EngineUnresponsive) {
            }
            try {
                PdfDocument.open(helloWorld)
                fail("opening behind the hung render completed")
            } catch (e: PdfError.EngineUnresponsive) {
            }
            val elapsedMillis = (System.nanoTime() - started) / 1_000_000
            assertTrue("failing fast took ${elapsedMillis}ms", elapsedMillis < 1_000)
        }
    }
}
