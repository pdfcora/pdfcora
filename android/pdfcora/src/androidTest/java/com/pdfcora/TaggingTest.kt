package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Mirrors `web/test/tagging.test.ts` and `ios/Tests/PDFCoraTests/TaggingTests.swift`. */
@RunWith(AndroidJUnit4::class)
class TaggingTest {

    private fun asset(path: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }
    private suspend fun untagged() = PdfDocument.open(asset("remediation/untagged.pdf"))

    private fun expectedBlocks(): List<PdfTagBlock> {
        val json = JSONArray(asset("remediation/untagged-expected.json").decodeToString())
        val next = mutableMapOf<Int, Int>()
        return (0 until json.length()).map { i ->
            val b = json.getJSONObject(i)
            val page = b.getInt("pageIndex")
            val start = next[page] ?: 0
            next[page] = start + b.getInt("objectCount")
            PdfTagBlock(page, PdfTagType.values().first { it.tag == b.getString("type") }, (start until start + b.getInt("objectCount")).toList())
        }
    }

    private fun shape(elements: List<PdfStructureElement>): String =
        elements.joinToString(" ") { if (it.children.isEmpty()) it.type else "${it.type}(${shape(it.children)})" }

    @Test fun writesTheStructureTreeListsIncluded() = runBlocking {
        val document = untagged()
        val tagged = document.tagContent(expectedBlocks(), title = "Quarterly newsletter", language = "en-GB")
        assertTrue(tagged.isTagged())
        assertFalse(document.isTagged())
        val page0 = tagged.page(0).structure()
        assertEquals("Document(H1 P H2 L(LI(LBody) LI(LBody) LI(LBody)) P Figure P)", shape(page0))
        assertEquals("Document(H2 L(LI(LBody) LI(LBody)) P)", shape(tagged.page(1).structure()))
        assertEquals(listOf(1, 2), page0[0].children[1].markedContentIds)

        val described = tagged.updateFigures(listOf(PdfFigureEdit.AltText(0, listOf(8), "The Berlin office at dusk")))
        // Pulled by scripts/test-android.sh for the PDF/UA check.
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "pdfcora-android-remediation.pdf")
            .writeBytes(described.toByteArray())
    }

    @Test fun aFigureCanBeDescribedWhileTagging() = runBlocking {
        val blocks = expectedBlocks().map { if (it.type == PdfTagType.FIGURE) it.copy(altText = "The Berlin office") else it }
        val tagged = untagged().tagContent(blocks, title = "T", language = "en")
        assertEquals("The Berlin office", tagged.page(0).structure()[0].children.first { it.type == "Figure" }.altText)
    }

    @Test fun refusesWhatItCannotWrite() = runBlocking {
        val document = untagged()
        val blocks = expectedBlocks()
        suspend fun refuses(blocks: List<PdfTagBlock>, title: String? = "T", language: String? = "en") {
            try {
                document.tagContent(blocks, title, language)
                fail("expected InvalidOperation")
            } catch (e: PdfError.InvalidOperation) {
            }
        }
        refuses(blocks + PdfTagBlock(0, PdfTagType.P, listOf(0)))
        refuses(listOf(PdfTagBlock(0, PdfTagType.P, listOf(99))))
        refuses(listOf(PdfTagBlock(0, PdfTagType.P, listOf(0), altText = "x")))
        refuses(blocks, title = null)
        refuses(blocks, language = null)
        val tagged = document.tagContent(blocks, "T", "en")
        try {
            tagged.tagContent(blocks, "T", "en")
            fail("expected already tagged")
        } catch (e: PdfError.InvalidOperation) {
        }
    }
}
