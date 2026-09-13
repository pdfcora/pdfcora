package com.pdfiumkit.ai

import com.pdfiumkit.PdfDocument

data class PdfiumAIOptions(
    val provider: PdfAiProvider? = null,
    /** Alpha prompt APIs stay off unless asked for (PRV-5). */
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
    /**
     * A feature that does nothing, so the not-available path can be exercised before
     * any real feature exists. Delete it when Phase 1 lands.
     */
    val stub = Stub(options)

    class Stub(private val options: PdfiumAIOptions) {
        /**
         * Android has no on-device route wired up in Phase 0 — ML Kit arrives with the
         * feature that needs it — so this is the provider or nothing.
         */
        fun availability(): PdfAiAvailability =
            if (options.provider != null) PdfAiAvailability.Available
            else PdfAiAvailability.Unavailable(PdfAiUnavailableReason.PLATFORM_UNSUPPORTED)

        /**
         * Asks the platform to fetch the model. AVL-4 forbids the SDK starting a
         * download on its own, so this exists to be called by the host and nowhere else.
         * With no on-device route there is nothing to fetch yet.
         */
        suspend fun prepare(onProgress: ((Float) -> Unit)? = null): PdfAiAvailability {
            onProgress?.invoke(1f)
            return availability()
        }

        suspend fun run(): PdfAiOutcome<String> = resolveRoutes(
            customProvider = {
                options.provider?.generate(PdfAiRequest(prompt = "ping"))?.text
            },
        )
    }
}
