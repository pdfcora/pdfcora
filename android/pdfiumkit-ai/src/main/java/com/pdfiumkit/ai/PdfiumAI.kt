package com.pdfiumkit.ai

import android.content.Context
import com.pdfiumkit.PdfDocument
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import com.pdfiumkit.ai.redaction.PdfRedactionCategory
import com.pdfiumkit.ai.redaction.PdfRedactionReview
import com.pdfiumkit.ai.redaction.suggestRedactions

data class PdfiumAIOptions(
    val provider: PdfAiProvider? = null,
    /**
     * The custom provider's context window in tokens. A custom provider cannot report its
     * own, so it is the integrator's to state.
     */
    val providerContextTokens: Int = 4096,
    /**
     * Needed for the on-device summariser. Without it, summaries fall back to the provider.
     */
    val context: Context? = null,
    /**
     * Alpha prompt APIs stay off unless asked for (PRV-5). No on-device prompt route
     * exists yet, so answers use the custom provider either way.
     */
    val experimentalOnDevicePrompt: Boolean = false,
)

/**
 * The entry point. One instance per document.
 *
 * Every feature reports availability separately (AVL-2) and re-checks it on each call
 * (AVL-3), because the user can turn the platform's AI off mid-session.
 */
class PdfiumAI(
    /** Only the core's public API is used (PKG-4). */
    val document: PdfDocument,
    val options: PdfiumAIOptions = PdfiumAIOptions(),
) {
    private val indexLock = Mutex()
    private var index: Deferred<PdfTextIndex>? = null

    private suspend fun textIndex(): PdfTextIndex = indexLock.withLock {
        index ?: CoroutineScope(Dispatchers.Default).async { TextLayer.index(document) }.also { index = it }
    }.await()

    /** Answers questions from the document, citing the sentences they came from (ANS). */
    val answers = Answers()

    /** Summarises the document or a page range (SUM). */
    val summaries = Summaries()

    /**
     * Suggests likely personal data to redact (RED). Patterns run on every device; the custom
     * provider, when configured, adds names, addresses, dates of birth and ID numbers.
     * Nothing is written until apply.
     */
    val redactions = Redactions()

    /**
     * Proposes values for the document's form fields from a profile the host passes in (FORM).
     * The synonym list runs on every device; the custom provider matches fields it cannot.
     * The profile is not stored. Nothing is written until apply.
     */
    val forms = Forms()

    /**
     * Lists figures in a tagged document that have no alternate text and proposes a
     * description, or decorative marking, for each (ALT). Descriptions come from ML Kit's
     * on-device image description when [PdfiumAIOptions.context] is set and the device has it,
     * else from the custom provider. Nothing is written until apply, which returns a new document.
     */
    val altText = AltText()

    /**
     * Proposes tags and a reading order for an untagged document (REM), by rules on the page
     * objects, identically on every platform. Nothing is written until apply, which returns a new
     * document; describe its figures with [altText] afterwards.
     */
    val remediation = Remediation()

    /**
     * Compares this document (the original) with a revised version: sentences aligned without a
     * model, and each reworded pair labelled as a change in meaning or wording by the custom provider.
     */
    val diff = Diff()

    inner class Diff {
        suspend fun compare(revised: PdfDocument, pages: IntRange? = null, revisedPages: IntRange? = null): com.pdfiumkit.ai.diff.PdfDiff =
            com.pdfiumkit.ai.diff.compareDocuments(this@PdfiumAI, revised, pages, revisedPages)
    }

    inner class Remediation {
        suspend fun suggest(pages: IntRange? = null): com.pdfiumkit.ai.remediation.PdfRemediationReview =
            com.pdfiumkit.ai.remediation.suggestRemediation(this@PdfiumAI, pages)
    }

    inner class AltText {
        suspend fun suggest(pages: IntRange? = null): com.pdfiumkit.ai.alttext.PdfAltTextReview =
            com.pdfiumkit.ai.alttext.suggestAltText(this@PdfiumAI, pages)
    }

    inner class Forms {
        suspend fun propose(
            profile: Map<com.pdfiumkit.ai.forms.PdfProfileKey, String>,
            pages: IntRange? = null,
        ): com.pdfiumkit.ai.forms.PdfFormProposals = com.pdfiumkit.ai.forms.proposeFormValues(this@PdfiumAI, profile, pages)

        /** Proposes form fields for the blanks of a flat PDF — lines, boxes, underscores (FORM-7). */
        suspend fun detect(pages: IntRange? = null): com.pdfiumkit.ai.forms.PdfDetectedFields =
            com.pdfiumkit.ai.forms.detectFields(document, pages)
    }

    inner class Redactions {
        suspend fun suggest(pages: IntRange? = null, categories: Set<PdfRedactionCategory>? = null): PdfRedactionReview =
            suggestRedactions(this@PdfiumAI, pages, categories)
    }

    inner class Answers {
        /** Android's on-device prompt API is alpha, so answers need a custom provider. */
        fun availability(): PdfAiAvailability =
            if (options.provider != null) PdfAiAvailability.Available
            else PdfAiAvailability.Unavailable(PdfAiUnavailableReason.NO_PROVIDER)

        suspend fun ask(question: String): PdfAiOutcome<PdfAnswer> {
            val provider = options.provider ?: return PdfAiOutcome.NotAvailable(availability())
            val index = try {
                textIndex()
            } catch (e: Exception) {
                return PdfAiOutcome.NotAvailable(PdfAiAvailability.Unavailable(PdfAiUnavailableReason.NO_PROVIDER))
            }
            val passages = GroundedAnswers.passages(index, question, options.providerContextTokens)
            // ANS-4: no relevant passage means no model call at all.
            if (passages.isEmpty()) {
                return PdfAiOutcome.Answered(PdfAiResult(PdfAnswer.NotFound(index.pagesWithoutText), PdfAiSource.RULES))
            }
            return Trial.answer(resolveRoutes(customProvider = {
                val response = provider.generate(PdfAiRequest(
                    prompt = GroundedAnswers.prompt(question, passages), schema = GroundedAnswers.SCHEMA))
                GroundedAnswers.parse(response.structured, response.text)
                    ?.let { GroundedAnswers.verify(it, document, index, passages) }
            }))
        }
    }

    inner class Summaries {
        /**
         * [language] is a BCP 47 tag. When the on-device summariser does not support it the
         * feature is unavailable rather than producing a poor summary (SUM-3).
         */
        suspend fun availability(language: String? = null): PdfAiAvailability {
            val onDevice = MlKitSummarizer.availability(options.context, language)
            if (onDevice == PdfAiAvailability.Unavailable(PdfAiUnavailableReason.LANGUAGE_NOT_SUPPORTED)) return onDevice
            if (onDevice.isUsable || options.provider != null) return PdfAiAvailability.Available
            // No summariser on this device at all: what would fix it is a provider.
            return if (onDevice == PdfAiAvailability.Unavailable(PdfAiUnavailableReason.PLATFORM_UNSUPPORTED))
                PdfAiAvailability.Unavailable(PdfAiUnavailableReason.NO_PROVIDER) else onDevice
        }

        /**
         * Downloads the on-device model. AVL-4 forbids the SDK starting a download on its
         * own, so this exists to be called by the host and nowhere else.
         */
        suspend fun prepare(onProgress: ((Float) -> Unit)? = null): PdfAiAvailability {
            MlKitSummarizer.prepare(options.context, onProgress)
            return availability()
        }

        /**
         * Call while the app is in the foreground. AICore blocks on-device inference from the
         * background, and the result is then [PdfAiUnavailableReason.BACKGROUND_USE_BLOCKED]
         * unless a custom provider answers instead.
         */
        suspend fun summarize(
            pages: IntRange? = null,
            style: PdfSummaryStyle = PdfSummaryStyle.PARAGRAPH,
            language: String? = null,
        ): PdfAiOutcome<PdfSummary> {
            val state = availability(language)
            if (!state.isUsable) return PdfAiOutcome.NotAvailable(state)
            val (pageTexts, pagesWithoutText) = TextLayer.readPages(document, pages)
            val texts = pageTexts.map { it.text }
            val provider = options.provider

            return Trial.summary(resolveRoutes(
                onDevice = {
                    MlKitSummarizer.open(options.context, style, language)?.let { summarise ->
                        SummaryText.summariseInWindows(texts, MlKitSummarizer.LIMIT_CHARS, MlKitSummarizer.MINIMUM_CHARS, summarise)
                            ?.let { PdfSummary(it, pagesWithoutText) }
                    }
                },
                customProvider = provider?.let {
                    {
                        val limit = (options.providerContextTokens * GroundedAnswers.CHARS_PER_TOKEN * 0.6).toInt()
                        PdfSummary(SummaryText.summariseInWindows(texts, limit) { part ->
                            provider.generate(PdfAiRequest(SummaryText.prompt(part, style))).text.trim()
                        }!!, pagesWithoutText)
                    }
                },
            ))
        }
    }
}
