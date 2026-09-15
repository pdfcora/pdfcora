package com.pdfiumkit.ai

import android.content.Context
import android.os.Build
import com.google.common.util.concurrent.ListenableFuture
import com.google.mlkit.genai.common.DownloadCallback
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.summarization.Summarization
import com.google.mlkit.genai.summarization.SummarizationRequest
import com.google.mlkit.genai.summarization.Summarizer
import com.google.mlkit.genai.summarization.SummarizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * ML Kit GenAI Summarization: Gemini Nano through AICore.
 *
 * Checked against `genai-summarization:1.0.0-beta1`: it needs API 26 (this module keeps
 * the core's 23, so every call is guarded), it summarises English, Japanese and Korean
 * only, and it produces one to three bullets — there is no paragraph output, so a
 * paragraph request gets one bullet.
 */
internal object MlKitSummarizer {
    /**
     * Characters per call. ML Kit documents an input limit of about 4,000 tokens; this is
     * three quarters of that at three characters per token, because the limit is not
     * reported at runtime and has not been measured on a device here.
     */
    const val LIMIT_CHARS = 9_000

    /** ML Kit refuses article input shorter than this, measured on a phone. */
    const val MINIMUM_CHARS = 400

    private fun supported(context: Context?): Boolean = context != null && Build.VERSION.SDK_INT >= 26

    /** ML Kit's language constant for a BCP 47 tag, or null when unsupported. English when unspecified. */
    private fun language(tag: String?): Int? = when (tag?.substringBefore('-')?.lowercase()) {
        null, "en" -> SummarizerOptions.Language.ENGLISH
        "ja" -> SummarizerOptions.Language.JAPANESE
        "ko" -> SummarizerOptions.Language.KOREAN
        else -> null
    }

    private fun client(context: Context, style: PdfSummaryStyle, language: Int): Summarizer =
        Summarization.getClient(
            SummarizerOptions.builder(context)
                .setInputType(SummarizerOptions.InputType.ARTICLE)
                .setOutputType(
                    if (style == PdfSummaryStyle.KEY_POINTS) SummarizerOptions.OutputType.THREE_BULLETS
                    else SummarizerOptions.OutputType.ONE_BULLET,
                )
                .setLanguage(language)
                .build(),
        )

    suspend fun availability(context: Context?, languageTag: String?): PdfAiAvailability {
        if (!supported(context)) return PdfAiAvailability.Unavailable(PdfAiUnavailableReason.PLATFORM_UNSUPPORTED)
        val language = language(languageTag)
            ?: return PdfAiAvailability.Unavailable(PdfAiUnavailableReason.LANGUAGE_NOT_SUPPORTED)
        val summarizer = client(context!!, PdfSummaryStyle.PARAGRAPH, language)
        return try {
            when (summarizer.checkFeatureStatus().await()) {
                FeatureStatus.AVAILABLE -> PdfAiAvailability.Available
                FeatureStatus.DOWNLOADABLE -> PdfAiAvailability.Downloadable
                FeatureStatus.DOWNLOADING -> PdfAiAvailability.Downloading()
                else -> PdfAiAvailability.Unavailable(PdfAiUnavailableReason.DEVICE_NOT_ELIGIBLE)
            }
        } catch (e: GenAiException) {
            // AICore missing or not supported on this device.
            PdfAiAvailability.Unavailable(PdfAiUnavailableReason.PLATFORM_UNSUPPORTED)
        } finally {
            summarizer.close()
        }
    }

    /** Downloads the model. Only ever called from the host's `prepare()` (AVL-4). */
    suspend fun prepare(context: Context?, onProgress: ((Float) -> Unit)?) {
        if (!supported(context)) return
        val summarizer = client(context!!, PdfSummaryStyle.PARAGRAPH, SummarizerOptions.Language.ENGLISH)
        try {
            var total = 0L
            summarizer.downloadFeature(object : DownloadCallback {
                override fun onDownloadStarted(bytesToDownload: Long) { total = bytesToDownload }
                override fun onDownloadProgress(totalBytesDownloaded: Long) {
                    if (total > 0) onProgress?.invoke(totalBytesDownloaded.toFloat() / total)
                }
                override fun onDownloadCompleted() { onProgress?.invoke(1f) }
                override fun onDownloadFailed(e: GenAiException) {}
            }).await()
        } catch (e: GenAiException) {
            // Reported through availability(), which the caller reads next.
        } finally {
            summarizer.close()
        }
    }

    /** Summarises one part. Null when the on-device model cannot run now. */
    suspend fun open(context: Context?, style: PdfSummaryStyle, languageTag: String?): (suspend (String) -> String)? {
        if (availability(context, languageTag) != PdfAiAvailability.Available) return null
        return { part ->
            val summarizer = client(context!!, style, language(languageTag)!!)
            try {
                summarizer.runInference(SummarizationRequest.builder(part).build()).await().summary
            } finally {
                summarizer.close()
            }
        }
    }

    private suspend fun <T> ListenableFuture<T>.await(): T = suspendCancellableCoroutine { continuation ->
        addListener({
            try {
                continuation.resume(get())
            } catch (e: java.util.concurrent.ExecutionException) {
                continuation.resumeWithException(e.cause ?: e)
            } catch (e: Exception) {
                continuation.resumeWithException(e)
            }
        }, Runnable::run)
        continuation.invokeOnCancellation { cancel(true) }
    }
}
