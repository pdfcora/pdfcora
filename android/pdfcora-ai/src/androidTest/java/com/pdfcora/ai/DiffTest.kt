package com.pdfcora.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.PdfDocument
import com.pdfcora.ai.diff.PdfDiffKind
import com.pdfcora.ai.diff.PdfDiffLabel
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

/** Mirrors `web-ai/test/diff.test.ts` and `ios/Tests/PDFCoraAITests/DiffTests.swift`. */
@RunWith(AndroidJUnit4::class)
class DiffTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun open(name: String) = PdfDocument.open(assets.open(name).use { it.readBytes() })

    @Test fun withoutAModelSentencesAlignAsExpected() = runBlocking {
        val expected = JSONArray(assets.open("expected.json").use { it.readBytes().decodeToString() })
        val diff = PdfAI(open("original.pdf")).diff.compare(open("revised.pdf"))
        assertFalse(diff.modelUsed)
        assertTrue(diff.notice.contains("Check the differences against both documents."))
        assertEquals(expected.length(), diff.changes.size)
        diff.changes.forEachIndexed { i, change ->
            val e = expected.getJSONObject(i)
            assertEquals(e.getString("kind"), change.kind.name.lowercase())
            assertEquals(e.optString("original").ifEmpty { null }, change.original?.text)
            assertEquals(e.optString("revised").ifEmpty { null }, change.revised?.text)
            assertEquals("c${i + 1}", change.id)
            listOfNotNull(change.original, change.revised).forEach { assertEquals(it.text, 1, it.rects.size) }
        }
        assertEquals(listOf(PdfDiffLabel.UNCLASSIFIED, PdfDiffLabel.MEANING_CHANGED, PdfDiffLabel.UNCLASSIFIED, PdfDiffLabel.MEANING_CHANGED),
            diff.changes.map { it.label })
        assertEquals(1, diff.changes[2].original?.pageIndex)
    }

    @Test fun aProviderLabelsRewordedPairs() = runBlocking {
        val calls = AtomicInteger()
        val provider = PdfAiProvider { request ->
            calls.incrementAndGet()
            if (request.prompt.contains("30 days")) PdfAiResponse("", """{"label":"meaningChanged","summary":"The notice period doubles to 60 days."}""")
            else PdfAiResponse("""{"label": "wordingOnly", "summary": ""}""")
        }
        val diff = PdfAI(open("original.pdf"), PdfAIOptions(provider = provider)).diff.compare(open("revised.pdf"))
        assertEquals(2, calls.get())
        assertTrue(diff.modelUsed)
        assertEquals(listOf(PdfDiffLabel.WORDING_ONLY, PdfDiffLabel.MEANING_CHANGED, PdfDiffLabel.MEANING_CHANGED, PdfDiffLabel.MEANING_CHANGED),
            diff.changes.map { it.label })
        assertEquals(listOf(null, null, "The notice period doubles to 60 days.", null), diff.changes.map { it.summary })

        val flakyCalls = AtomicInteger()
        val flaky = PdfAiProvider { if (flakyCalls.getAndIncrement() == 0) PdfAiResponse("""{"label":"maybe"}""") else error("offline") }
        val unsure = PdfAI(open("original.pdf"), PdfAIOptions(provider = flaky)).diff.compare(open("revised.pdf"))
        assertFalse(unsure.modelUsed)
        assertEquals(listOf(PdfDiffLabel.UNCLASSIFIED, PdfDiffLabel.UNCLASSIFIED), unsure.changes.filter { it.kind == PdfDiffKind.MODIFIED }.map { it.label })
    }
}
