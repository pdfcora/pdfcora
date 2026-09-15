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

    // Long documents are read in windows: each call carries the summary so far and the next
    // stretch of text, so later parts are summarised knowing what came before (SUM-2).
    private val pages = (0 until 30).map { "Marker$it opens this page. " + "Clause text goes here. ".repeat(40) }
    private val next = "Next part:\n"

    private fun markers(inputs: List<String>): List<Int> = inputs
        .map { if (it.contains(next)) it.substringAfter(next) else it }
        .flatMap { text -> Regex("""Marker(\d+)""").findAll(text).map { it.groupValues[1].toInt() } }

    private suspend fun windows(limit: Int, reply: (String, Int) -> String): Triple<List<String>, List<String>, String?> {
        val inputs = mutableListOf<String>()
        val outputs = mutableListOf<String>()
        val result = SummaryText.summariseInWindows(pages, limit) { input ->
            inputs += input
            reply(input, inputs.size).also { outputs += it }
        }
        return Triple(inputs, outputs, result)
    }

    @Test
    fun everyWindowStaysWithinTheLimitAndTheLastSummaryIsTheResult() = runTest {
        val (inputs, outputs, result) = windows(2_000) { _, call -> "S$call" }
        assertTrue("thirty long pages cannot fit one window", inputs.size > 1)
        for (input in inputs) assertTrue("a call received ${input.length} characters", input.length <= 2_000)
        assertEquals(outputs.last(), result)
    }

    @Test
    fun eachWindowAfterTheFirstCarriesTheSummaryOfEverythingBeforeIt() = runTest {
        val (inputs, outputs, _) = windows(2_000) { _, call -> "S$call" }
        assertFalse("the first window is plain text", inputs[0].contains(next))
        for (i in 1 until inputs.size) {
            assertTrue("call ${i + 1}", inputs[i].startsWith("Summary of the earlier parts:\n${outputs[i - 1]}\n\n$next"))
        }
    }

    @Test
    fun everyPageIsReadExactlyOnceInOrder() = runTest {
        val (inputs, _, _) = windows(2_000) { _, call -> "S$call" }
        assertEquals(pages.indices.toList(), markers(inputs))
    }

    @Test
    fun aSummaryThatGrowsTooLongIsCondensedBeforeItCrowdsOutTheText() = runTest {
        val (inputs, _, result) = windows(2_000) { input, _ -> "kept. ".repeat(input.length / 7) }
        for (input in inputs) assertTrue("a call received ${input.length} characters", input.length <= 2_000)
        assertTrue("the summary was condensed", inputs.any { !it.contains(next) && it.startsWith("kept.") })
        assertEquals("no page is lost to condensing", pages.indices.toList(), markers(inputs))
        assertFalse(result.isNullOrEmpty())
    }

    /** Given a bulleted summary to carry forward, Apple's model bullets its lines again. */
    @Test
    fun repeatedBulletMarkersFromTheModelCollapseToOne() = runTest {
        val result = SummaryText.summariseInWindows(listOf("A short page."), 2_000) {
            "- - First point\n* - Second point\n- Third point\nA - dash inside a line"
        }
        assertEquals("- First point\n- Second point\n- Third point\nA - dash inside a line", result)
    }

    @Test
    fun aDocumentThatFitsOneWindowIsOneCallWithThePlainText() = runTest {
        val inputs = mutableListOf<String>()
        val result = SummaryText.summariseInWindows(listOf("A short page.", "Another page."), 2_000) { inputs += it; "ok" }
        assertEquals(listOf("A short page.\n\nAnother page."), inputs)
        assertEquals("ok", result)
    }

    /** ML Kit refuses article input under 400 characters, measured on a phone. */
    private suspend fun mlKitLike(text: String): String {
        if (text.length < 400) throw IllegalArgumentException("Input text length is smaller than the minimum of 400")
        return "S"
    }

    @Test
    fun textShorterThanTheMinimumIsNotSentAndTheRouteStepsAside() = runTest {
        var calls = 0
        val result = SummaryText.summariseInWindows(listOf("A short page."), 7_860, minimum = 400) { calls++; mlKitLike(it) }
        assertNull(result)
        assertEquals(0, calls)
    }

    @Test
    fun aWindowUnderTheMinimumIsNotSentAndItsTextIsKept() = runTest {
        // Four pages fill the first window; the fifth, with a one-letter summary, makes a
        // second window far under 400 characters.
        val long = (0 until 4).map { "Page $it. " + "Clause text goes here. ".repeat(20) }
        val limit = long.joinToString("\n\n").length
        val inputs = mutableListOf<String>()
        val result = SummaryText.summariseInWindows(long + "Marker99 is short.", limit, minimum = 400) {
            inputs += it
            mlKitLike(it)
        }
        assertEquals(1, inputs.size)
        assertEquals("S\n\nMarker99 is short.", result)
    }
}
