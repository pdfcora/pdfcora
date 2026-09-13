package com.pdfiumkit.ai

/** Where an answer came from. Shown to users and logged for audits (PRV-3). */
enum class PdfAiSource { ON_DEVICE, CUSTOM_PROVIDER, RULES }

data class PdfAiResult<T>(val value: T, val source: PdfAiSource)

data class PdfAiRequest(
    val prompt: String,
    /** Encoded images, for providers that accept them. */
    val images: List<ByteArray> = emptyList(),
    /** JSON Schema for structured output, when the feature needs one. */
    val schema: String? = null,
)

data class PdfAiResponse(val text: String, val structured: String? = null)

/** Implemented by the integrator: their own server, or their own model. */
fun interface PdfAiProvider {
    suspend fun generate(request: PdfAiRequest): PdfAiResponse
}

/** The outcome of resolving the routes: an answer, or why there wasn't one. */
sealed class PdfAiOutcome<out T> {
    data class Answered<T>(val result: PdfAiResult<T>) : PdfAiOutcome<T>()
    data class NotAvailable(val state: PdfAiAvailability) : PdfAiOutcome<Nothing>()
}

/**
 * Tries each route in the fixed order of PRV-2 and reports which one answered.
 *
 * A route returning null and a route throwing are treated the same — both move on to
 * the next route — because a custom provider is someone else's server, and its outage
 * must not take down a feature that has a rules fallback.
 */
suspend fun <T> resolveRoutes(
    onDevice: (suspend () -> T?)? = null,
    customProvider: (suspend () -> T?)? = null,
    rules: (suspend () -> T?)? = null,
): PdfAiOutcome<T> {
    val ordered = listOf(
        PdfAiSource.ON_DEVICE to onDevice,
        PdfAiSource.CUSTOM_PROVIDER to customProvider,
        PdfAiSource.RULES to rules,
    )

    for ((source, route) in ordered) {
        if (route == null) continue
        val value = try {
            route()
        } catch (e: Exception) {
            // Deliberately swallowed: the next route is the fallback this exists for.
            null
        }
        if (value != null) return PdfAiOutcome.Answered(PdfAiResult(value, source))
    }
    return PdfAiOutcome.NotAvailable(
        PdfAiAvailability.Unavailable(PdfAiUnavailableReason.NO_PROVIDER),
    )
}
