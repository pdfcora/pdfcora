package com.pdfiumkit.ai

import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import com.google.common.util.concurrent.ListenableFuture
import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.common.GenAiException
import com.google.mlkit.genai.imagedescription.ImageDescriberOptions
import com.google.mlkit.genai.imagedescription.ImageDescription
import com.google.mlkit.genai.imagedescription.ImageDescriptionRequest
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * ML Kit GenAI Image Description: Gemini Nano through AICore.
 *
 * Checked against `genai-image-description:1.0.0-beta1`: it needs API 26 (every call is
 * guarded), describes in English only and takes no prompt, so it cannot use the page text
 * and never answers "decorative". It is not downloaded here (AVL-4); a device without the
 * feature ready falls through to the provider.
 */
internal object MlKitImageDescriber {
    /** AICore's BACKGROUND_USE_BLOCKED, newer than this ML Kit release's error codes. */
    private const val BACKGROUND_USE_BLOCKED = 30

    /** Describes one image. Null when the on-device model cannot run now. */
    suspend fun describe(context: Context?, image: Bitmap): String? {
        if (context == null || Build.VERSION.SDK_INT < 26) return null
        val describer = ImageDescription.getClient(ImageDescriberOptions.builder(context).build())
        return try {
            if (describer.checkFeatureStatus().await() != FeatureStatus.AVAILABLE) return null
            describer.runInference(ImageDescriptionRequest.builder(image).build()).await().description.trim().ifEmpty { null }
        } catch (e: GenAiException) {
            if (e.errorCode == BACKGROUND_USE_BLOCKED) throw PdfAiUnavailableException(PdfAiUnavailableReason.BACKGROUND_USE_BLOCKED)
            throw e
        } finally {
            describer.close()
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
