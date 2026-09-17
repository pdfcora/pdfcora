package com.pdfcora.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.PdfDocument
import com.pdfcora.PdfSaveMode
import com.pdfcora.ai.redaction.PdfRedactionCategory
import com.pdfcora.ai.redaction.UnknownSuggestionException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RedactionSuggestTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun pii() = PdfDocument.open(assets.open("pii.pdf").use { it.readBytes() })
    private fun items(vararg pairs: Pair<String, String>) = PdfAiProvider {
        PdfAiResponse(text = "", structured = JSONObject().put("items", JSONArray().apply {
            pairs.forEach { (c, q) -> put(JSONObject().put("category", c).put("quote", q)) }
        }).toString())
    }

    @Test fun patternsAloneFindExactlyTheExpectedItems() = runBlocking {
        val expected = JSONArray(assets.open("pii-expected.json").use { it.readBytes().decodeToString() })
            .let { a -> (0 until a.length()).map { a.getJSONObject(it).run { Triple(getInt("pageIndex"), getString("category"), getString("text")) } } }
        val review = PdfAI(pii()).redactions.suggest()
        assertFalse(review.modelUsed)
        assertTrue(review.notice.contains("Suggestions may be incomplete. Review the whole document."))
        assertEquals(expected, review.suggestions.map { Triple(it.pageIndex, it.category.id, it.text) })
        review.suggestions.forEach {
            assertEquals(PdfAiSource.RULES, it.source)
            assertEquals("${it.pageIndex}:${it.start}-${it.end}:${it.category.id}", it.id)
            assertTrue(it.text, it.rects.isNotEmpty())
        }
    }

    @Test fun modelQuotesAreVerifiedExpandedAndNeverOverlapAPattern() = runBlocking {
        val provider = items("personName" to "Anna Schmidt", "personName" to "Nobody Invented",
            "dateOfBirth" to "14 March 1985", "idNumber" to "Li", "bankBalance" to "Customer record")
        val review = PdfAI(pii(), PdfAIOptions(provider)).redactions.suggest(pages = 0..0)
        assertTrue(review.modelUsed)
        assertEquals(listOf("personName" to "Anna Schmidt", "personName" to "Anna Schmidt"),
            review.suggestions.filter { it.source == PdfAiSource.CUSTOM_PROVIDER }.map { it.category.id to it.text })
    }

    @Test fun aFailingModelLeavesThePatterns() = runBlocking {
        val review = PdfAI(pii(), PdfAIOptions(PdfAiProvider { throw java.io.IOException("offline") })).redactions.suggest()
        assertFalse(review.modelUsed)
        assertEquals(25, review.suggestions.size)
    }

    @Test fun applyRemovesAcceptedTextKeepsRejectedAndUndoRestores() = runBlocking {
        val document = pii()
        val review = PdfAI(document).redactions.suggest(pages = 0..0)
        val email = review.suggestions.first { it.category == PdfRedactionCategory.EMAIL }
        val iban = review.suggestions.first { it.category == PdfRedactionCategory.IBAN }
        val applied = review.apply(listOf(email.id))
        assertEquals(emptyList<Any>(), applied.remaining)
        val text = PdfDocument.open(document.toByteArray(PdfSaveMode.FULL)).page(0).text.string()
        assertFalse(text.contains(email.text))
        assertTrue(text.contains(iban.text))
        assertTrue(text.contains("Email"))
        assertTrue(applied.undo().page(0).text.string().contains(email.text))
    }

    @Test fun anUnknownIdWritesNothing() = runBlocking {
        val document = pii()
        val review = PdfAI(document).redactions.suggest()
        val first = review.suggestions[0]
        assertThrows(UnknownSuggestionException::class.java) { runBlocking { review.apply(listOf(first.id, "nope")) } }
        assertTrue(document.page(0).text.string().contains(first.text))
    }
}
