package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.xfdf.PdfXfdfReport
import com.pdfcora.xfdf.PdfXfdfSkip
import com.pdfcora.xfdf.PdfXfdfSkipReason
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web/test/xfdf-import.test.ts` and `ios/Tests/PDFCoraTests/XfdfImportTests.swift`. */
@RunWith(AndroidJUnit4::class)
class XfdfImportTest {
    private fun asset(path: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }
    private fun text(path: String) = asset(path).decodeToString()
    private suspend fun blank() = PdfDocument.open(asset("xfdf/source-blank.pdf"))

    private fun assertInvalid(block: suspend () -> Unit) {
        try { runBlocking { block() }; fail("accepted") } catch (e: PdfError.InvalidOperation) { /* expected */ }
    }

    @Test fun importsConformanceFile() = runBlocking {
        val report = blank().importXfdf(text("xfdf/import.xfdf"))
        val want = JSONObject(text("xfdf/expected-import.json")).getJSONObject("report")
        val skipped = want.getJSONArray("skipped").let { a ->
            (0 until a.length()).map { i ->
                val s = a.getJSONObject(i)
                PdfXfdfSkip(s.getString("element"), if (s.has("page")) s.getInt("page") else null,
                    PdfXfdfSkipReason.fromWire(s.getString("reason")))
            }
        }
        assertEquals(PdfXfdfReport(want.getInt("fieldsSet"), want.getInt("annotationsAdded"), skipped), report)
    }

    @Test fun exportsWhatWasImported() = runBlocking {
        val document = blank()
        document.importXfdf(text("xfdf/import.xfdf"))
        assertEquals(text("xfdf/expected-after-import.xfdf"), document.exportXfdf())
    }

    @Test fun rejectsDoctype() = runBlocking {
        val document = blank()
        val before = document.exportXfdf()
        assertInvalid { document.importXfdf(text("xfdf/doctype.xfdf")) }
        assertEquals(before, document.exportXfdf())
    }

    @Test fun rejectsMalformed() = runBlocking {
        val document = blank()
        val before = document.exportXfdf()
        assertInvalid { document.importXfdf(text("xfdf/malformed.xfdf")) }
        assertInvalid { document.importXfdf("<notxfdf/>") }
        assertEquals(before, document.exportXfdf())
    }

    @Test fun rejectsOversizedInput() = runBlocking {
        val document = blank()
        assertInvalid { document.importXfdf("a".repeat(10_485_761)) }
    }

    @Test fun importingTwiceAddsTwice() = runBlocking {
        val document = blank()
        val xfdf = text("xfdf/import.xfdf")
        assertEquals(5, document.importXfdf(xfdf).annotationsAdded)
        assertEquals(5, document.importXfdf(xfdf).annotationsAdded)
        assertEquals(2, document.page(0).annotations().filterIsInstance<PdfAnnotation.Ink>().size)
    }

    @Test fun savedDocumentKeepsAuthorAndDates() = runBlocking {
        val document = blank()
        document.importXfdf(text("xfdf/import.xfdf"))
        val xfdf = PdfDocument.open(document.toByteArray(PdfSaveMode.FULL)).exportXfdf()
        assertTrue(xfdf.contains("title=\"Imported &amp; signed\""))
        assertTrue(xfdf.contains("date=\"D:20261030100000Z\""))
        assertTrue(xfdf.contains("name=\"imp-ink\""))
    }
}
