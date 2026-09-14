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
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Ignore
import org.junit.Test
import org.junit.runner.RunWith

/**
 * How far a hung render spreads.
 *
 * This test used to assert the opposite of what it asserts now, and the reversal is the
 * point. Documents once owned a thread each, so a hang cost exactly that document — but
 * that isolation was only possible because calls were *not* serialised across documents,
 * and PDFium's global state is not thread-safe. `CrossDocumentStressTest` kills the
 * process reproducibly under the old arrangement.
 *
 * Every PDFium call now runs on one engine thread, so a hung render wedges the engine
 * for everyone. That is strictly worse for liveness and strictly better for memory
 * safety, and there is no third option while PDFium stays single-threaded: correctness
 * requires serialisation, and serialisation means one stuck call blocks the queue.
 *
 * Making that survivable — a watchdog that abandons a wedged thread and fails the calls
 * behind it — is a design decision, not a bug fix, and is deliberately not smuggled in
 * here. This test pins the current behaviour so the trade-off is visible rather than
 * discovered.
 */
@RunWith(AndroidJUnit4::class)
@LeaksNativeThreads
class BlastRadiusTest {
    private fun asset(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { it.readBytes() }

    @Ignore(
        "Cannot run against a serialised engine. The test works by wedging a render " +
            "forever, and there is now one engine thread, so the wedge outlives the test " +
            "and takes every later call with it — including this test's own assertion. " +
            "Re-enable if a watchdog is added that can abandon a stuck engine thread.",
    )
    @Test
    fun aHungRenderWedgesTheEngineForEveryone() = runTest {
        // Real dispatchers and real time: runTest's virtual clock would skip the delays
        // that let the hang actually start.
        withContext(Dispatchers.Default) {
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

            val hung = PdfDocument.open(asset("hang-probe.pdf"))
            val page = hung.page(0)
            scope.launch { runCatching { page.render(width = 80) } }
            delay(500)

            // Coroutines unrelated to the engine keep running: the wedge is one thread,
            // not the whole process.
            var ticks = 0
            repeat(10) { delay(100); ticks++ }
            assertEquals("unrelated coroutines were starved", 10, ticks)

            // But anything that needs the engine is stuck behind the hung call, however
            // unrelated the document.
            val other = withTimeoutOrNull(4_000) {
                PdfDocument.open(asset("corpus/hello_world.pdf")).page(0).render(width = 120).width
            }
            assertNull(
                "a hung render no longer blocks other documents — if this passes, the " +
                    "engine is no longer serialised, and CrossDocumentStressTest should " +
                    "be failing too",
                other,
            )
        }
    }
}
