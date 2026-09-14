package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.view.*
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The viewer itself, which needs a real document. The pure view model is unit-tested off
 * device in `src/test` — only what genuinely needs the engine lives here.
 *
 * Mirrors `web/test/viewer.test.ts` and the iOS ViewerTests.
 */
@RunWith(AndroidJUnit4::class)
class ViewerTest {

    // The corpus pages are 200x200 — smaller than any plausible viewport — so viewports
    // must be small and zoom high enough that the content actually overflows. Otherwise
    // the page fits entirely, nothing scrolls, and every scroll assertion is vacuous.
    private val phone = PdfViewport(390f, 700f)
    private val wide = PdfViewport(600f, 500f)
    private val scrollable = PdfZoom(4f, PdfZoomMode.FREE)

    private fun corpus(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("corpus/$name").use { it.readBytes() }

    private suspend fun open() = PdfDocument.open(corpus("hello_world.pdf"))

    private fun remote(sequence: Int, state: PdfViewState) =
        PdfViewEvent(sequence, "them", PdfViewEventOrigin.REMOTE, PdfViewChange.Viewport(state))

    @Test
    fun everyChangeEmitsExactlyOneEvent() = runTest {
        open().use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            val seen = mutableListOf<PdfViewEvent>()
            val job = launch { viewer.events.collect { seen += it } }
            yield()

            viewer.zoomIn()
            viewer.flush()
            yield()

            assertEquals(1, seen.size)
            assertEquals(PdfViewEventOrigin.LOCAL, seen[0].origin)
            job.cancel()
        }
    }

    @Test
    fun applyingARemoteEventEmitsNothing() = runTest {
        // Without this, two synced viewers echo each other forever.
        open().use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            val seen = mutableListOf<PdfViewEvent>()
            val job = launch { viewer.events.collect { seen += it } }
            yield()

            viewer.apply(remote(1, viewer.state.copy(zoom = PdfZoom(2f, PdfZoomMode.FREE))))
            yield()

            assertEquals(emptyList<PdfViewEvent>(), seen)
            assertEquals(2f, viewer.state.zoom.scale, 0f)
            job.cancel()
        }
    }

    @Test
    fun anOutOfOrderEventDoesNotRewindTheView() = runTest {
        open().use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            viewer.apply(remote(5, viewer.state.copy(zoom = PdfZoom(2f, PdfZoomMode.FREE))))
            viewer.apply(remote(3, viewer.state.copy(zoom = PdfZoom(4f, PdfZoomMode.FREE))))
            assertEquals("sequence 3 arrived late and must be ignored",
                         2f, viewer.state.zoom.scale, 0f)
        }
    }

    @Test
    fun aPeerOnAnotherScreenLandsOnTheSameContent() = runTest {
        open().use { document ->
            val a = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            val b = PdfViewer.open(document, wide, PdfViewerOptions(coalesceMillis = 0))

            a.zoomTo(scrollable)
            a.scrollTo(PdfPoint(120f, 90f))
            b.apply(remote(1, a.state))

            val centre = b.transform().centerForScrollOffset(b.scrollOffset(), wide)
            assertEquals(120f, centre.x, 1f)
            assertEquals(90f, centre.y, 1f)
        }
    }

    @Test
    fun aFitIsReDerivedByTheReceiverButAFreeZoomIsNot() = runTest {
        open().use { document ->
            val narrow = PdfViewer.open(document, PdfViewport(300f, 700f), PdfViewerOptions(coalesceMillis = 0))
            val broad = PdfViewer.open(document, PdfViewport(900f, 700f), PdfViewerOptions(coalesceMillis = 0))

            narrow.fitWidth()
            broad.apply(remote(1, narrow.state))
            assertEquals(PdfZoomMode.FIT_WIDTH, broad.state.zoom.mode)
            assertTrue("the broad window fits its own width",
                       broad.state.zoom.scale > narrow.state.zoom.scale)

            broad.apply(remote(2, narrow.state.copy(zoom = PdfZoom(2.4f, PdfZoomMode.FREE))))
            assertEquals("a deliberate zoom is adopted verbatim", 2.4f, broad.state.zoom.scale, 0f)
        }
    }

    @Test
    fun resizingReDerivesAFitButLeavesADeliberateZoomAlone() = runTest {
        open().use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            viewer.fitWidth()
            val fitted = viewer.state.zoom.scale
            viewer.setViewport(PdfViewport(780f, 700f))
            assertTrue(viewer.state.zoom.scale > fitted)

            viewer.zoomTo(PdfZoom(1.5f, PdfZoomMode.FREE))
            viewer.setViewport(phone)
            assertEquals("a deliberate zoom survives a resize", 1.5f, viewer.state.zoom.scale, 0f)
        }
    }

    @Test
    fun scrollingPastThePageClampsRatherThanRunningAway() = runTest {
        open().use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            viewer.zoomTo(scrollable)
            repeat(50) { viewer.scrollBy(500f, 500f) }

            val offset = viewer.scrollOffset()
            val t = viewer.transform()
            assertTrue("both axes must genuinely scroll, or this asserts nothing",
                       t.viewWidth > phone.width && t.viewHeight > phone.height)
            assertTrue("x ran away: ${offset.x}", offset.x <= t.viewWidth - phone.width + 0.5f)
            assertTrue("y ran away: ${offset.y}", offset.y <= t.viewHeight - phone.height + 0.5f)
        }
    }

    @Test
    fun aPageIndexOutOfRangeIsClampedNotThrown() = runTest {
        open().use { document ->
            val viewer = PdfViewer.open(document, phone, PdfViewerOptions(coalesceMillis = 0))
            viewer.goToPage(99)
            assertEquals("hello_world.pdf has one page", 0, viewer.state.pageIndex)
        }
    }
}
