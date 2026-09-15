package com.pdfiumkit.ai

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parts of answers and summaries that need no document: the same assertions as
 * `web-ai/test/answers.test.ts` and `summaries.test.ts`. The document-level twins run on
 * a device in `androidTest`.
 */
class AnswersLogicTest {

    // MARK: - Quote verification

    @Test
    fun quotesTolerateWhitespaceAndLineBreaks() {
        val source = "Intro.  The notice\r\nperiod   is three months."
        assertEquals(8 until source.length, locateQuote(source, "The notice period is three months."))
    }

    @Test
    fun quotesTolerateAWordHyphenatedAcrossALine() {
        val source = "Payment on manage-\nment approval."
        assertEquals(source.indices, locateQuote(source, "Payment on management approval."))
    }

    @Test
    fun quotesKeepACompoundThatBreaksAtALineEnd() {
        val source = "A well-\nknown supplier."
        assertEquals(source.indices, locateQuote(source, "A well-known supplier."))
    }

    @Test
    fun quotesDoNotTolerateDifferentWordsPunctuationOrCase() {
        val source = "The notice period is three months."
        assertNull(locateQuote(source, "The notice period is 3 months."))
        assertNull(locateQuote(source, "The notice period is three months!"))
        assertNull(locateQuote(source, "the notice period is three months."))
        assertNull(locateQuote(source, "   "))
    }

    // MARK: - Retrieval

    @Test
    fun retrievalRanksThePassageSharingRareTermsFirst() {
        val passages = listOf(
            "Invoices are payable within thirty days.",
            "The notice period is three months.",
            "Deliveries arrive weekly.",
        ).mapIndexed { i, text -> TextLayer.passagesOf(PdfPageText(i, text)).single() }
        val picked = Retrieval.retrieve(passages, "How long is the notice period?", 10_000)
        assertEquals("The notice period is three months.", picked.first().text)
        assertFalse(picked.any { it.text.startsWith("Deliveries") })
    }

    @Test
    fun retrievalStopsAtTheBudget() {
        val passages = TextLayer.passagesOf(PdfPageText(0, "The notice period is three months."))
        assertEquals(emptyList<PdfPassage>(), Retrieval.retrieve(passages, "notice period", 5))
    }

    @Test
    fun passagesKeepTheirCharacterRangeInThePage() {
        val text = "One.  Two words here."
        val passage = TextLayer.passagesOf(PdfPageText(3, text)).single()
        assertEquals(passage.text, text.substring(passage.start, passage.end))
    }

    // MARK: - Reply parsing

    @Test
    fun aReplyIsReadFromStructuredOutputOrFencedJsonText() {
        val json = """{"answer":"Three months.","citations":[{"passage":"p1-0","quote":"Q."}]}"""
        val expected = PdfGroundedReply("Three months.", listOf(PdfGroundedReply.Citation("p1-0", "Q.")))
        assertEquals(expected, GroundedAnswers.parse(json, ""))
        assertEquals(expected, GroundedAnswers.parse(null, "```json\n$json\n```"))
        assertNull(GroundedAnswers.parse(null, "not json"))
    }

    @Test
    fun thePromptPutsEachPassageOnOneLineAndEndsWithTheQuestion() {
        val passage = PdfPassage("p1-0", 1, 0, 20, "Line one.\r\nLine two.")
        val prompt = GroundedAnswers.prompt("When?", listOf(passage))
        assertTrue(prompt.contains("[p1-0] (page 2) Line one. Line two."))
        assertTrue(prompt.endsWith("Question: When?"))
        assertNotNull(GroundedAnswers.SCHEMA)
    }

    // MARK: - Summaries

    @Test
    fun longTextIsSplitSoNoCallExceedsTheLimit() = runTest {
        val pages = (0 until 50).map { "Page $it. " + "Clause text goes here. ".repeat(40) }
        val inputs = mutableListOf<String>()
        val result = SummaryText.summarise(pages, 2_000) { text ->
            inputs += text
            "S${inputs.size}: ${text.take(40)}"
        }
        assertTrue(inputs.size > 1)
        for (input in inputs) assertTrue("a call received ${input.length} characters", input.length <= 2_000)
        assertTrue(result.startsWith("S"))
    }

    /** ML Kit refuses article input under 400 characters, measured on a phone. */
    private suspend fun mlKitLike(text: String): String {
        if (text.length < 400) throw IllegalArgumentException("Input text length is smaller than the minimum of 400")
        return "- summary of ${text.length} characters"
    }

    @Test
    fun textShorterThanTheMinimumIsNotSentAndTheRouteStepsAside() = runTest {
        var calls = 0
        val result = SummaryText.summariseAtLeast(listOf("A short page."), 9_000, 400) { calls++; mlKitLike(it) }
        assertNull(result)
        assertEquals(0, calls)
    }

    @Test
    fun shortPartsOfALongDocumentPassThroughInsteadOfFailing() = runTest {
        // Long pages, whose short bullet summaries are then combined: the combining call
        // is well under 400 characters and would be refused.
        val pages = (0 until 6).map { "Page $it. " + "Clause text goes here. ".repeat(60) }
        val result = SummaryText.summariseAtLeast(pages + "A short last page.", 2_000, 400, ::mlKitLike)
        assertNotNull(result)
        assertTrue(result!!.contains("summary of"))
    }

    @Test
    fun aSinglePageLongerThanTheLimitIsSplitAtSentences() = runTest {
        val inputs = mutableListOf<String>()
        SummaryText.summarise(listOf("First sentence here. ".repeat(200)), 300) { inputs += it; "ok" }
        for (input in inputs) assertTrue(input.length <= 300)
    }
}
