package com.pdfcora.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.PdfDocument
import com.pdfcora.PdfStructureElement
import com.pdfcora.PdfTagType
import com.pdfcora.isTagged
import com.pdfcora.structure
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web-ai/test/remediation.test.ts` and `ios/Tests/PDFCoraAITests/RemediationTests.swift`. */
@RunWith(AndroidJUnit4::class)
class RemediationTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun untagged() = PdfDocument.open(assets.open("untagged.pdf").use { it.readBytes() })
    private fun types(e: List<PdfStructureElement>): List<String> = e.flatMap { listOf(it.type) + types(it.children) }

    @Test fun theRulesProposeExactlyTheExpectedBlocks() = runBlocking {
        val expected = JSONArray(assets.open("untagged-expected.json").use { it.readBytes().decodeToString() })
        val review = PdfAI(untagged()).remediation.suggest()
        assertFalse(review.alreadyTagged)
        assertTrue(review.notice.contains("Check every tag and the reading order before they are written."))
        assertEquals(expected.length(), review.blocks.size)
        review.blocks.forEachIndexed { i, block ->
            val e = expected.getJSONObject(i)
            assertEquals(e.getInt("pageIndex"), block.pageIndex)
            assertEquals(e.getString("type"), block.type.tag)
            assertEquals(e.getInt("objectCount"), block.objectIndices.size)
            assertEquals(e.getString("text"), block.text)
            assertEquals(i + 1, block.order)
            assertEquals("${block.pageIndex}:${block.objectIndices[0]}", block.id)
        }
    }

    /** PDF/UA 7.4.2. Real documents often set a late line larger than the first heading;
     *  by size alone this document would start at H2 and skip to H3. */
    @Test fun headingLevelsStartAtH1AndNeverSkip() = runBlocking {
        val expected = JSONArray(assets.open("heading-order-expected.json").use { it.readBytes().decodeToString() })
        val document = PdfDocument.open(assets.open("heading-order.pdf").use { it.readBytes() })
        val review = PdfAI(document).remediation.suggest()
        assertEquals(expected.length(), review.blocks.size)
        review.blocks.forEachIndexed { i, block ->
            assertEquals(expected.getJSONObject(i).getString("type"), block.type.tag)
        }
    }

    @Test fun applyTagsWithOverrides() = runBlocking {
        val document = untagged()
        val review = PdfAI(document).remediation.suggest()
        val caption = review.blocks.first { it.text.startsWith("Figure 1") }
        val tagged = review.apply(mapOf(caption.id to PdfTagType.H3), language = "en-GB")
        assertEquals(listOf("Document", "H1", "P", "H2", "L", "LI", "LBody", "LI", "LBody", "LI", "LBody", "P", "Figure", "H3"),
            types(tagged.page(0).structure()))
        assertFalse(document.isTagged())
    }

    @Test fun unknownOverridesThrowAndTaggedDocumentsAreNotProposedFor() = runBlocking {
        val review = PdfAI(untagged()).remediation.suggest()
        try { review.apply(mapOf("9:9" to PdfTagType.P), language = "en"); fail() } catch (e: UnknownProposalException) {}
        val again = PdfAI(review.apply(language = "en")).remediation.suggest()
        assertTrue(again.alreadyTagged)
        assertEquals(emptyList<Any>(), again.blocks)
    }
}
