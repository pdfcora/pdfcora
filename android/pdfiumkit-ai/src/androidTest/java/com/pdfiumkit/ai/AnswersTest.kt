package com.pdfiumkit.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.PdfDocument
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/** The same assertions as `web-ai/test/answers.test.ts`, against the same contract. */
@RunWith(AndroidJUnit4::class)
class AnswersTest {
    private val notice = "The notice period is three months, ending on the last day of a calendar month."

    private suspend fun contract() = PdfDocument.open(
        InstrumentationRegistry.getInstrumentation().context.assets.open("contract.pdf").use { it.readBytes() })

    private class Model(val reply: (String) -> String) : PdfAiProvider {
        val requests = mutableListOf<PdfAiRequest>()
        override suspend fun generate(request: PdfAiRequest): PdfAiResponse {
            requests += request
            return PdfAiResponse(text = "", structured = reply(request.prompt))
        }
    }

    private fun passageId(prompt: String, text: String): String =
        prompt.lines().first { it.contains(text) }.drop(1).takeWhile { it != ']' }

    private fun reply(answer: String, passage: String, quote: String): String = JSONObject()
        .put("answer", answer)
        .put("citations", JSONArray().put(JSONObject().put("passage", passage).put("quote", quote)))
        .toString()

    private fun answered(outcome: PdfAiOutcome<PdfAnswer>): Pair<PdfAnswer.Answered, PdfAiSource> {
        val result = (outcome as? PdfAiOutcome.Answered)?.result
            ?: throw AssertionError("expected a result, got $outcome")
        val value = result.value as? PdfAnswer.Answered
            ?: throw AssertionError("expected an answer, got ${result.value}")
        return value to result.source
    }

    /** Llama 3.2 3B, through Ollama, cited the same sentence three times in one reply. */
    @Test
    fun aSentenceCitedTwiceIsHighlightedOnceAndStillGrounded() = runTest {
        val document = contract()
        val model = Model {
            val citation = JSONObject().put("passage", passageId(it, notice)).put("quote", notice)
            JSONObject().put("answer", "Three months.").put("citations", JSONArray().put(citation).put(citation)).toString()
        }
        val (answer, _) = answered(PdfiumAI(document, PdfiumAIOptions(model)).answers.ask("What is the notice period?"))
        assertEquals(1, answer.citations.size)
        assertTrue(answer.grounded)
        document.close()
    }

    @Test
    fun theNoticePeriodQuestionHighlightsExactlyThatSentence() = runTest {
        val document = contract()
        val model = Model { reply("Three months.", passageId(it, notice), notice) }
        val (answer, source) = answered(PdfiumAI(document, PdfiumAIOptions(model)).answers.ask("What's the notice period?"))

        assertEquals(PdfAiSource.CUSTOM_PROVIDER, source)
        assertTrue(answer.grounded)
        val citation = answer.citations.single()
        assertEquals(1, citation.pageIndex)
        assertEquals(notice, citation.quote)
        assertEquals(notice, document.page(1).text.string().substring(citation.start, citation.end))
        val rect = citation.rects.single()
        assertTrue("left edge ${rect.left} is not after \"12.1 \"", rect.left > 72 && rect.left < 110)
        assertTrue("$rect is not on line two", rect.bottom >= 700 && rect.top <= 720)
        document.close()
    }

    @Test
    fun aQuestionWithNoAnswerIsNotFoundWithoutCallingTheModel() = runTest {
        val document = contract()
        val model = Model { fail("the model must not be called (ANS-4)"); "" }
        val outcome = PdfiumAI(document, PdfiumAIOptions(model)).answers.ask("zeppelin xylophone?")
        assertEquals(
            PdfAiOutcome.Answered(PdfAiResult<PdfAnswer>(PdfAnswer.NotFound(listOf(2)), PdfAiSource.RULES)),
            outcome,
        )
        assertTrue(model.requests.isEmpty())
        document.close()
    }

    @Test
    fun aMadeUpQuoteNeverProducesAHighlight() = runTest {
        val document = contract()
        val model = Model { reply("Six months.", passageId(it, notice), "The notice period is six months.") }
        val (answer, _) = answered(PdfiumAI(document, PdfiumAIOptions(model)).answers.ask("What's the notice period?"))
        assertTrue(answer.citations.isEmpty())
        assertFalse(answer.grounded)
        document.close()
    }

    /**
     * Apple's model quoted correctly but named passages "p1-3" and "13. Payment": ids are
     * what it gets wrong, so the quote, not the id, decides.
     */
    @Test
    fun aQuoteCreditedToTheWrongOrAnUnknownPassageIsFoundInThePassagesShown() = runTest {
        val document = contract()
        for (id in listOf<(String) -> String>({ passageId(it, "maintenance services") }, { "13. Payment" })) {
            val model = Model { reply("Three months.", id(it), notice) }
            val (answer, _) = answered(PdfiumAI(document, PdfiumAIOptions(model)).answers.ask(
                "What is the notice period for the maintenance services?"))
            assertTrue(answer.grounded)
            assertEquals(1, answer.citations.first().pageIndex)
            assertEquals(notice, answer.citations.first().quote)
        }
        document.close()
    }

    @Test
    fun aRealSentenceTheModelWasNotShownIsNeverACitation() = runTest {
        val document = contract()
        val start = "The agreement starts on 1 March 2026 and runs for an initial term of two years."
        val model = Model {
            assertFalse("the budget should admit only the page-2 passage", it.contains("1 March 2026"))
            reply("Three months.", passageId(it, notice), start)
        }
        // Room for one passage, so page 1 is never in the prompt.
        val ai = PdfiumAI(document, PdfiumAIOptions(model, providerContextTokens = 200))
        val (answer, _) = answered(ai.answers.ask("What is the notice period?"))
        assertTrue(answer.citations.isEmpty())
        assertFalse(answer.grounded)
        document.close()
    }

    /**
     * Apple's model answers "not mentioned in the passages" instead of the empty answer the
     * prompt asks for. Without a citation there is nothing to verify or highlight.
     */
    @Test
    fun anAnswerWithNoCitationsIsNotFoundWhateverItsTextSays() = runTest {
        val document = contract()
        val model = Model { """{"answer":"The capital of France is not mentioned in the passages.","citations":[]}""" }
        assertEquals(
            PdfAiOutcome.Answered(PdfAiResult<PdfAnswer>(PdfAnswer.NotFound(listOf(2)), PdfAiSource.CUSTOM_PROVIDER)),
            PdfiumAI(document, PdfiumAIOptions(model)).answers.ask("What is the notice period?"),
        )
        document.close()
    }

    @Test
    fun thePromptCarriesRetrievedPassagesASchemaAndTheQuestion() = runTest {
        val document = contract()
        val model = Model { """{"answer":"","citations":[]}""" }
        PdfiumAI(document, PdfiumAIOptions(model)).answers.ask("When are invoices payable?")
        val request = model.requests.single()
        assertTrue(request.schema != null)
        assertTrue(request.prompt.contains("Invoices are payable within thirty days of receipt."))
        assertTrue(request.prompt.endsWith("Question: When are invoices payable?"))
        document.close()
    }

    @Test
    fun withoutAProviderOrContextSummariesAndAnswersAreUnavailable() = runTest {
        val document = contract()
        val ai = PdfiumAI(document)
        val none = PdfAiAvailability.Unavailable(PdfAiUnavailableReason.NO_PROVIDER)
        assertEquals(none, ai.answers.availability())
        assertEquals(PdfAiOutcome.NotAvailable(none), ai.answers.ask("notice period"))
        assertEquals(PdfAiOutcome.NotAvailable(none), ai.summaries.summarize())
        document.close()
    }

    @Test
    fun aProviderSummarisesAPageRange() = runTest {
        val document = contract()
        val prompts = mutableListOf<String>()
        val ai = PdfiumAI(document, PdfiumAIOptions(PdfAiProvider { prompts += it.prompt; PdfAiResponse(" A contract. ") }))
        val outcome = ai.summaries.summarize(pages = 0..0)
        // This module's instrumented tests run without a license key, so output is marked.
        assertEquals(PdfAiOutcome.Answered(PdfAiResult(PdfSummary(Trial.PREFIX + "A contract.", emptyList()), PdfAiSource.CUSTOM_PROVIDER)),
                     outcome)
        assertTrue(prompts.joinToString().contains("1. Parties"))
        assertFalse(prompts.joinToString().contains("12. Termination"))
        document.close()
    }
}
