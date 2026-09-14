package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch

/**
 * Every PDFium call shares one engine thread, so a call that never returns would block
 * every document forever. Calls queued behind one that outlives the deadline fail fast
 * instead, and service resumes if it ever returns.
 */
@RunWith(AndroidJUnit4::class)
class EngineWatchdogTest {
    private fun corpus(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open("corpus/$name").use { it.readBytes() }

    @After
    fun restoreTimeout() {
        PdfDocument.engineTimeoutMillis = 30_000
    }

    private suspend fun expectUnresponsive(what: String, block: suspend () -> Unit) {
        try {
            block()
            fail("$what completed behind the stuck call")
        } catch (e: PdfError.EngineUnresponsive) {
        }
    }

    @Test
    fun callsBehindAStuckCallFailFastAndServiceResumesWhenItReturns() = runTest {
        withContext(Dispatchers.Default) {
            val bytes = corpus("hello_world.pdf")
            val document = PdfDocument.open(bytes)
            PdfDocument.engineTimeoutMillis = 500

            val release = CountDownLatch(1)
            EngineExecutor.execute { release.await() }
            delay(1_000)

            val started = System.nanoTime()
            expectUnresponsive("a call") { document.page(0).text.string() }
            expectUnresponsive("opening") { PdfDocument.open(bytes) }
            val elapsedMillis = (System.nanoTime() - started) / 1_000_000
            assertTrue("failing fast took ${elapsedMillis}ms", elapsedMillis < 500)

            release.countDown()
            delay(200)
            assertTrue(document.page(0).text.string().contains("Hello"))
            document.close()
        }
    }

    @Test
    fun workQueuedBeforeTheDeadlineIsFailedToo() = runTest {
        withContext(Dispatchers.Default) {
            val document = PdfDocument.open(corpus("hello_world.pdf"))
            PdfDocument.engineTimeoutMillis = 500

            val release = CountDownLatch(1)
            EngineExecutor.execute { release.await() }
            delay(100)

            // Queued while the engine is merely busy, before the deadline has passed.
            supervisorScope {
                val queued = async { document.page(0).text.string() }
                expectUnresponsive("the queued call") { queued.await() }
            }

            release.countDown()
            delay(200)
            document.close()
        }
    }
}
