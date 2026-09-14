package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Hammers several documents at once, which the SDK permits.
 *
 * Each document owns a single-thread executor, so calls on *one* document are
 * serialised — but there is no lock across documents, and PDFium's global state is not
 * thread-safe. `PdfDocument.close()` says so itself: closing from the wrong thread
 * "races every other document's in-flight work, which corrupts global engine state
 * rather than failing loudly".
 *
 * If that is the source of the rare SIGSEGV seen on the document thread, this is where
 * it should surface: many documents, many threads, text search and rendering at once.
 */
@RunWith(AndroidJUnit4::class)
class CrossDocumentStressTest {

    private fun corpus(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("corpus/$name").use { it.readBytes() }

    private val files = listOf(
        "hello_world.pdf", "text_form.pdf", "rectangles.pdf", "many_rectangles.pdf",
        "text_font.pdf", "find_text_consecutive.pdf",
    )

    @Test
    fun manyDocumentsWorkingAtOnceDoNotCorruptTheEngine() = runTest {
        withContext(Dispatchers.Default) {
            repeat(12) { round ->
                coroutineScope {
                    files.map { name ->
                        async {
                            PdfDocument.open(corpus(name)).use { document ->
                                val page = document.page(0)
                                // The three things the crashing stack touched: text
                                // search, text extraction and rendering.
                                page.text.search("e")
                                page.text.string()
                                document.page(0).render(120)
                                page.annotations().size
                            }
                        }
                    }.awaitAll()
                }
            }
        }
        assertTrue("survived", true)
    }

    @Test
    fun openingAndClosingDocumentsWhileOthersWorkDoesNotCorruptTheEngine() = runTest {
        // close() frees on the document's own thread precisely because doing it
        // elsewhere races other documents. This checks that the intended path holds up
        // when a document is being closed while others are mid-call.
        withContext(Dispatchers.Default) {
            coroutineScope {
                val workers = (0 until 4).map {
                    async {
                        repeat(15) {
                            PdfDocument.open(corpus("many_rectangles.pdf")).use { document ->
                                document.page(0).text.search("1")
                                document.page(0).render(80)
                            }
                        }
                    }
                }
                val churn = (0 until 4).map {
                    async {
                        repeat(30) {
                            val document = PdfDocument.open(corpus("hello_world.pdf"))
                            document.page(0).text.string()
                            document.close()
                        }
                    }
                }
                (workers + churn).awaitAll()
            }
        }
        assertTrue("survived", true)
    }
}
