package com.pdfiumkit.ai

import org.junit.Assert.assertEquals
import org.junit.Test

class TrialTest {
    @Test fun prefixesWithoutAnAiLicense() {
        val answer = PdfAiOutcome.Answered(PdfAiResult<PdfAnswer>(
            PdfAnswer.Answered("Yes.", emptyList(), true, emptyList()), PdfAiSource.RULES))
        val marked = Trial.answer(answer, licensed = false) as PdfAiOutcome.Answered<PdfAnswer>
        assertEquals("PdfiumKit trial — Yes.", (marked.result.value as PdfAnswer.Answered).text)

        val summary = PdfAiOutcome.Answered(PdfAiResult(PdfSummary("Short.", emptyList()), PdfAiSource.RULES))
        assertEquals("Short.", (Trial.summary(summary, licensed = true) as PdfAiOutcome.Answered<PdfSummary>).result.value.text)
    }
}
