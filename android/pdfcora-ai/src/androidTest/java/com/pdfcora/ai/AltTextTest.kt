package com.pdfcora.ai

import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.PdfDocument
import com.pdfcora.PdfStructureElement
import com.pdfcora.ai.alttext.MissingDescriptionException
import com.pdfcora.ai.alttext.PdfAltTextDecision
import com.pdfcora.ai.alttext.PdfAltTextKind
import com.pdfcora.structure
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections

/** Mirrors `web-ai/test/alt-text.test.ts` and `ios/Tests/PDFCoraAITests/AltTextTests.swift`. */
@RunWith(AndroidJUnit4::class)
class AltTextTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun tagged() = PdfDocument.open(assets.open("tagged.pdf").use { it.readBytes() })
    private val expected = JSONObject(assets.open("tagged-expected.json").use { it.readBytes().decodeToString() })
    private val withoutAlt = expected.getJSONArray("figuresWithoutAlt").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    private suspend fun figures(document: PdfDocument, page: Int): List<PdfStructureElement> {
        fun flatten(e: List<PdfStructureElement>): List<PdfStructureElement> = e.flatMap { listOf(it) + flatten(it.children) }
        return flatten(document.page(page).structure()).filter { it.type == "Figure" }
    }

    @Test fun withoutAModelTheFiguresAreListedAndTheRuleIsDecorative() = runBlocking {
        val review = PdfAI(tagged()).altText.suggest()
        assertFalse(review.untagged)
        assertFalse(review.modelUsed)
        assertTrue(review.notice.contains("Check every description before it is written."))
        assertEquals(withoutAlt.size, review.items.size)
        review.items.zip(withoutAlt).forEach { (item, figure) ->
            assertEquals(figure.getInt("pageIndex"), item.pageIndex)
            val ids = figure.getJSONArray("markedContentIds").let { a -> (0 until a.length()).map { a.getInt(it) } }
            assertEquals(ids, item.markedContentIds)
            assertEquals(figure.getString("kind"), item.kind.name.lowercase())
            assertEquals("${item.pageIndex}:${item.markedContentIds.joinToString(",")}", item.id)
            assertEquals("", item.text)
            assertEquals(if (item.kind == PdfAltTextKind.DECORATIVE) PdfAiSource.RULES else null, item.source)
            if (figure.has("caption")) assertTrue(item.context, item.context.contains(figure.getString("caption")))
        }
    }

    @Test fun aProviderGetsOnePngPerDescribedFigure() = runBlocking {
        val requests = Collections.synchronizedList(mutableListOf<PdfAiRequest>())
        val provider = PdfAiProvider { request ->
            requests += request
            val logo = request.prompt.contains("company logo")
            PdfAiResponse("""{"decorative":false,"description":"${if (logo) "Red circle logo" else "Office building at dusk"}"}""")
        }
        val review = PdfAI(tagged(), PdfAIOptions(provider = provider)).altText.suggest()
        assertEquals(2, requests.size)
        for (request in requests) {
            assertEquals(1, request.images.size)
            assertNotNull(BitmapFactory.decodeByteArray(request.images[0], 0, request.images[0].size))
        }
        assertTrue(review.modelUsed)
        assertEquals(listOf("Office building at dusk", "", "Red circle logo"), review.items.map { it.text })
        assertEquals(listOf(PdfAiSource.CUSTOM_PROVIDER, PdfAiSource.RULES, PdfAiSource.CUSTOM_PROVIDER), review.items.map { it.source })
    }

    @Test fun decorativeAnswersAreHonouredAndAThrowingProviderLeavesTextEmpty() = runBlocking {
        var calls = 0
        val provider = PdfAiProvider {
            if (calls++ == 0) PdfAiResponse("", """{"decorative":true,"description":""}""") else error("offline")
        }
        val review = PdfAI(tagged(), PdfAIOptions(provider = provider)).altText.suggest()
        assertEquals(listOf(PdfAltTextKind.DECORATIVE, PdfAltTextKind.DECORATIVE, PdfAltTextKind.DESCRIPTION), review.items.map { it.kind })
        assertEquals(listOf(PdfAiSource.CUSTOM_PROVIDER, PdfAiSource.RULES, null), review.items.map { it.source })
    }

    @Test fun applyWritesProposedAndEditedDecisions() = runBlocking {
        val provider = PdfAiProvider { PdfAiResponse("""{"decorative":false,"description":"Office building"}""") }
        val review = PdfAI(tagged(), PdfAIOptions(provider = provider)).altText.suggest()
        val updated = review.apply(listOf(
            PdfAltTextDecision(review.items[0].id), PdfAltTextDecision(review.items[1].id),
            PdfAltTextDecision(review.items[2].id, text = "Company logo"),
        ))
        val chart = expected.getJSONArray("figuresWithAlt").getJSONObject(0).getString("altText")
        assertEquals(listOf(chart, "Office building"), figures(updated, 0).map { it.altText })
        assertEquals(listOf("Company logo"), figures(updated, 1).map { it.altText })
        assertEquals(0, PdfAI(updated).altText.suggest().items.size)
    }

    @Test fun applyRefusesUnknownIdsAndMissingDescriptions() = runBlocking {
        val review = PdfAI(tagged()).altText.suggest()
        try { review.apply(listOf(PdfAltTextDecision("9:9"))); fail() } catch (e: UnknownProposalException) {}
        try { review.apply(listOf(PdfAltTextDecision(review.items[0].id))); fail() } catch (e: MissingDescriptionException) {}
    }

    @Test fun anUntaggedDocumentIsReported() = runBlocking {
        val review = PdfAI(PdfDocument.open(assets.open("forms.pdf").use { it.readBytes() })).altText.suggest()
        assertTrue(review.untagged)
        assertEquals(emptyList<Any>(), review.items)
    }
}
