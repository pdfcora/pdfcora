package com.pdfiumkit.ai

/** Why a feature cannot run. */
enum class PdfAiUnavailableReason {
    /** The hardware cannot run it. */
    DEVICE_NOT_ELIGIBLE,

    /** The user turned the platform's AI off. */
    NOT_ENABLED,

    /** Present but not loaded yet. */
    MODEL_NOT_READY,

    /** No such API on this OS. */
    PLATFORM_UNSUPPORTED,

    /** The document's language is not supported by the platform. */
    LANGUAGE_NOT_SUPPORTED,

    /** No on-device route and no custom provider configured. */
    NO_PROVIDER,

    /** A model or provider was tried and failed, and no other route answered. */
    REQUEST_FAILED,

    /** The platform refuses on-device inference while the app is in the background. */
    BACKGROUND_USE_BLOCKED,
}

/**
 * Whether a feature can run right now.
 *
 * A superset of what any one platform reports. Apple has only [Available] and
 * [Unavailable]; Android and Web genuinely distinguish a model that could be downloaded
 * from one that is downloading, which is why those two states exist here.
 */
sealed class PdfAiAvailability {
    object Available : PdfAiAvailability()
    object Downloadable : PdfAiAvailability()
    data class Downloading(val progress: Float? = null) : PdfAiAvailability()
    data class Unavailable(val reason: PdfAiUnavailableReason) : PdfAiAvailability()

    val isUsable: Boolean get() = this is Available
}
