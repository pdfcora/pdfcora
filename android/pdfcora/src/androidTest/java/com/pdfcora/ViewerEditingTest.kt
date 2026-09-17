package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.view.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web/test/viewer-*.test.ts` and the iOS ViewerEditingTests. */
@RunWith(AndroidJUnit4::class)
class ViewerEditingTest {

    private val phone = PdfViewport(390f, 700f)
    private val rect = PdfRect(10f, 10f, 30f, 30f)

    private fun corpus(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("corpus/$name").use { it.readBytes() }

    /**
     * Blanks the trailer's `/ID`. PDFium regenerates it on every save on some platforms,
     * so without this the gate would fail even comparing a document with itself.
     * Everything else must still match byte for byte.
     */
    private fun withoutDocumentId(bytes: ByteArray): String =
        bytes.toString(Charsets.ISO_8859_1)
            .replace(Regex("/ID\\[<[0-9A-Fa-f]*><[0-9A-Fa-f]*>\\]"), "/ID[<><>]")

    @Test
    fun anEditReachesTheDocumentAndEmitsOnce() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            val seen = mutableListOf<PdfViewEvent>()
            val job = launch { viewer.events.collect { seen += it } }
            yield()

            viewer.addNote(rect, "hello")
            yield()

            assertEquals(1, seen.size)
            assertEquals(1, document.page(0).annotations().size)
            job.cancel()
        }
    }

    @Test
    fun anEditIsNotCoalescedAway() = runTest {
        // A one-second viewport window makes the distinction unambiguous.
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 1000))
            val seen = mutableListOf<PdfViewEvent>()
            val job = launch { viewer.events.collect { seen += it } }
            yield()

            viewer.addNote(rect, "one")
            viewer.addNote(PdfRect(40f, 10f, 60f, 30f), "two")
            yield()

            assertEquals("both edits, despite the throttle", 2, seen.size)
            job.cancel()
        }
    }

    @Test
    fun theViewerDelegatesRatherThanReimplementing() = runTest {
        // Two code paths producing annotations would drift, and the bug would appear
        // through only one of them. Byte identity is the only check strong enough.
        val viaPage = PdfDocument.open(corpus("hello_world.pdf"))
        viaPage.page(0).addNote(rect, "hello", PdfColor.YELLOW)
        val fromPage = viaPage.toByteArray(PdfSaveMode.FULL)
        viaPage.close()

        val viaViewer = PdfDocument.open(corpus("hello_world.pdf"))
        PdfViewer.open(viaViewer, phone, PdfViewerOptions(coalesceMillis = 0))
            .addNote(rect, "hello", PdfColor.YELLOW)
        val fromViewer = viaViewer.toByteArray(PdfSaveMode.FULL)
        viaViewer.close()

        assertEquals("the viewer has diverged from the page API",
                     withoutDocumentId(fromPage), withoutDocumentId(fromViewer))
    }

    @Test
    fun redactionThroughTheViewerRemovesContentFromTheBytes() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            val target = document.pageObjects(0).first { it.text?.contains("Goodbye") == true }

            viewer.redact(listOf(PdfRedactionTarget.Region(target.bounds, 0)))

            val saved = document.toByteArray(PdfSaveMode.FULL)
            assertFalse("still in the file bytes",
                        saved.toString(Charsets.ISO_8859_1).contains("Goodbye"))
        }
    }

    @Test
    fun theSameBytesShareAFingerprint() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { a ->
            PdfDocument.open(corpus("hello_world.pdf")).use { b ->
                PdfDocument.open(corpus("text_form.pdf")).use { other ->
                    assertEquals(a.fingerprint, b.fingerprint)
                    assertNotEquals(a.fingerprint, other.fingerprint)
                }
            }
        }
    }

    @Test
    fun anAppliedEditReproducesTheChangeAndDoesNotEcho() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { sourceDocument ->
            PdfDocument.open(corpus("hello_world.pdf")).use { peerDocument ->
                val source = PdfViewer.open(sourceDocument, phone, PdfViewerOptions(coalesceMillis = 0))
                val peer = PdfViewer.open(peerDocument, phone, PdfViewerOptions(coalesceMillis = 0))

                val sent = mutableListOf<PdfViewEvent>()
                val echoed = mutableListOf<PdfViewEvent>()
                val a = launch { source.events.collect { sent += it } }
                val b = launch { peer.events.collect { echoed += it } }
                yield()

                source.addNote(rect, "hello")
                yield()
                peer.apply(sent.first().copy(origin = PdfViewEventOrigin.REMOTE))
                yield()

                assertEquals("applying must not echo", emptyList<PdfViewEvent>(), echoed)
                assertEquals(1, peerDocument.page(0).annotations().size)
                a.cancel(); b.cancel()
            }
        }
    }

    @Test
    fun anEditForADifferentDocumentIsRefused() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            try {
                viewer.apply(PdfViewEvent(
                    1, "them", PdfViewEventOrigin.REMOTE,
                    PdfViewChange.Edit(PdfEdit.AnnotationRemoved(0, 0)), "not-mine",
                ))
                throw AssertionError("expected a refusal")
            } catch (e: PdfDocumentMismatchException) {
                assertTrue(e.message!!.contains("different document"))
            }
        }
    }

    @Test
    fun aFollowerCannotEditButMayStillLookAround() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val follower = PdfViewer.open(
                document, phone,
                PdfViewerOptions(coalesceMillis = 0, role = PdfViewerRole.FOLLOWER),
            )
            try {
                follower.addNote(rect, "nope")
                throw AssertionError("expected a refusal")
            } catch (e: PdfFollowerException) {
                // Following is not being frozen.
                follower.zoomIn()
                assertTrue(follower.state.zoom.scale > 0f)
            }
        }
    }

    @Test
    fun anEditFromSomeoneWhoIsNotThePresenterIsIgnored() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val follower = PdfViewer.open(
                document, phone,
                PdfViewerOptions(coalesceMillis = 0, role = PdfViewerRole.FOLLOWER, presenterId = "boss"),
            )
            val note = PdfEdit.NoteAdded(0, rect, "x", PdfColor.YELLOW)

            follower.apply(PdfViewEvent(1, "someone-else", PdfViewEventOrigin.REMOTE,
                                        PdfViewChange.Edit(note), document.fingerprint))
            assertEquals("nothing was added", 0, document.page(0).annotations().size)

            follower.apply(PdfViewEvent(2, "boss", PdfViewEventOrigin.REMOTE,
                                        PdfViewChange.Edit(note), document.fingerprint))
            assertEquals(1, document.page(0).annotations().size)
        }
    }
}
