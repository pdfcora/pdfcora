package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.view.*
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SnapshotAndMarksTest {
    private fun corpus(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open("corpus/$name").use { it.readBytes() }

    @Test fun aSnapshotReopensTheDocumentAsItWas() = runBlocking {
        val document = PdfDocument.open(corpus("hello_world.pdf"))
        document.page(0).addNote(PdfRect(10f, 10f, 30f, 30f), "kept")
        val snapshot = document.snapshot()
        document.redact(listOf(PdfRedactionTarget.TextMatches("Hello")))
        val copy = snapshot.open()
        assertTrue(copy.page(0).text.string().contains("Hello"))
        assertEquals(1, copy.page(0).annotations().size)
    }

    private suspend fun viewer() = PdfViewer.open(PdfDocument.open(corpus("hello_world.pdf")), PdfViewport(400f, 600f))

    @Test fun marksAreHitTestedAndTapsCycle() = runBlocking {
        val v = viewer()
        v.setMarks(listOf(PdfMark("a", 0, listOf(PdfRect(10f, 10f, 100f, 40f))), PdfMark("b", 0, listOf(PdfRect(50f, 20f, 80f, 30f)))))
        assertEquals("b", v.markAt(0, PdfPoint(60f, 25f)))
        assertNull(v.markAt(1, PdfPoint(20f, 15f)))
        val states = (0 until 3).map { v.tapMark(0, PdfPoint(20f, 15f)); v.marks[0].state }
        assertEquals(listOf(PdfMarkState.ACCEPTED, PdfMarkState.REJECTED, PdfMarkState.PENDING), states)
        v.setAllMarks(PdfMarkState.ACCEPTED)
        assertEquals(listOf(PdfMarkState.ACCEPTED, PdfMarkState.ACCEPTED), v.marks.map { it.state })
    }

    @Test fun marksNeverReachTheEventStream() = runBlocking {
        val v = viewer()
        var events = 0
        val scope = CoroutineScope(Dispatchers.Default)
        v.events.onEach { events++ }.launchIn(scope)
        v.setMarks(listOf(PdfMark("a", 0, listOf(PdfRect(10f, 10f, 100f, 40f)))))
        v.tapMark(0, PdfPoint(20f, 20f))
        v.setAllMarks(PdfMarkState.REJECTED)
        v.flush()
        kotlinx.coroutines.delay(100)
        scope.cancel()
        assertEquals(0, events)
    }
}
