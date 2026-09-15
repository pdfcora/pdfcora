package com.pdfiumkit.ai

import android.util.Log
import com.pdfiumkit.license.PdfLicense
import com.pdfiumkit.license.PdfLicenseModule

/** Marks model output produced without an `ai` license. Quotes are never touched. */
internal object Trial {
    const val PREFIX = "PdfiumKit trial — "
    @Volatile private var warned = false

    private fun licensedNow() = PdfLicense.status.covers(PdfLicenseModule.AI)

    /** SDK text shown without an `ai` license gets the same prefix as model output. */
    fun text(value: String, licensed: Boolean = licensedNow()): String = if (licensed) value else PREFIX + value

    fun answer(outcome: PdfAiOutcome<PdfAnswer>, licensed: Boolean = licensedNow()): PdfAiOutcome<PdfAnswer> {
        if (licensed || outcome !is PdfAiOutcome.Answered) return outcome
        val value = outcome.result.value as? PdfAnswer.Answered ?: return outcome
        warn()
        return PdfAiOutcome.Answered(outcome.result.copy(value = value.copy(text = PREFIX + value.text)))
    }

    fun summary(outcome: PdfAiOutcome<PdfSummary>, licensed: Boolean = licensedNow()): PdfAiOutcome<PdfSummary> {
        if (licensed || outcome !is PdfAiOutcome.Answered) return outcome
        warn()
        val value = outcome.result.value
        return PdfAiOutcome.Answered(outcome.result.copy(value = value.copy(text = PREFIX + value.text)))
    }

    private fun warn() {
        if (warned) return
        warned = true
        try {
            Log.w("PdfiumKit", "AI output is marked as trial — the license key does not include the ai module")
        } catch (e: RuntimeException) {
            // android.util.Log is a stub in JVM unit tests.
        }
    }
}
