package com.pdfiumkit.ai.alttext

import android.graphics.Bitmap
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfFigureEdit
import com.pdfiumkit.PdfPage
import com.pdfiumkit.PdfRect
import com.pdfiumkit.PdfStructureElement
import com.pdfiumkit.ai.*
import com.pdfiumkit.boundingBox
import com.pdfiumkit.isTagged
import com.pdfiumkit.structure
import com.pdfiumkit.updateFigures
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.roundToInt

const val ALT_TEXT_NOTICE = "Check every description before it is written."

enum class PdfAltTextKind { DESCRIPTION, DECORATIVE }

data class PdfAltTextProposal(
    /** `"<pageIndex>:<marked-content ids joined by ,>"`. */
    val id: String,
    val pageIndex: Int,
    val markedContentIds: List<Int>,
    val rect: PdfRect,
    val kind: PdfAltTextKind,
    /** Empty when no route proposed a description; a person writes one. */
    val text: String,
    val source: PdfAiSource?,
    /** The page text given to the model as context. */
    val context: String,
)

/** A person's decision on one proposal: [text] replaces the proposed description. */
data class PdfAltTextDecision(val id: String, val text: String? = null, val decorative: Boolean? = null)

class MissingDescriptionException(id: String) : IllegalArgumentException("no description for $id")

class PdfAltTextReview internal constructor(
    /** True when the document is not tagged: nothing is listed, it needs tags first. */
    val untagged: Boolean,
    val items: List<PdfAltTextProposal>,
    val modelUsed: Boolean,
    /** Must be shown with the proposals (HIL). */
    val notice: String,
    private val document: PdfDocument,
) {
    /** Writes the decisions, returning a new document; this document is unchanged. */
    suspend fun apply(decisions: List<PdfAltTextDecision>): PdfDocument {
        val byId = items.associateBy { it.id }
        val edits = decisions.map { decision ->
            val item = byId[decision.id] ?: throw UnknownProposalException(decision.id)
            val decorative = decision.decorative ?: (item.kind == PdfAltTextKind.DECORATIVE)
            val text = (decision.text ?: item.text).trim()
            when {
                decorative -> PdfFigureEdit.Decorative(item.pageIndex, item.markedContentIds)
                text.isEmpty() -> throw MissingDescriptionException(decision.id)
                else -> PdfFigureEdit.AltText(item.pageIndex, item.markedContentIds, text)
            }
        }
        return document.updateFigures(edits)
    }
}

internal object AltTextProposer {
    const val CONTEXT_MARGIN = 48f
    const val CONTEXT_CHARS = 500
    const val IMAGE_PIXELS = 512f
    const val MAX_SCALE = 4f

    const val SCHEMA = """{"type":"object","properties":{"decorative":{"type":"boolean"},"description":{"type":"string"}},"required":["decorative","description"]}"""

    fun prompt(context: String): String = listOf(
        "Write alternative text for the attached image from a PDF, for a reader who cannot see it.",
        "One sentence of at most 150 characters saying what the image shows and why it matters here.",
        "Do not begin with \"Image of\" or \"Picture of\".",
        "If the image is only decoration and adds no information, answer decorative true with an empty description.",
        "Text near the image on the page: ${JSONObject.quote(context)}",
    ).joinToString("\n")

    /** Spec §2: too thin or too small to carry information. */
    fun looksDecorative(rect: PdfRect): Boolean = minOf(rect.width, rect.height) <= 3f || rect.width * rect.height <= 100f

    data class Answer(val decorative: Boolean, val description: String)

    fun parse(text: String): Answer? {
        val from = text.indexOf('{'); val to = text.lastIndexOf('}')
        if (from < 0 || to < from) return null
        val json = runCatching { JSONObject(text.substring(from, to + 1)) }.getOrNull() ?: return null
        if (json.optBoolean("decorative", false)) return Answer(true, "")
        val description = json.optString("description", "").trim()
        return if (description.isEmpty()) null else Answer(false, description)
    }

    fun missingAlt(elements: List<PdfStructureElement>): List<PdfStructureElement> = elements.flatMap { e ->
        val missing = e.type == "Figure" && e.altText.isNullOrBlank() && e.actualText.isNullOrBlank() &&
            e.bounds != null && e.markedContentIds.isNotEmpty()
        (if (missing) listOf(e) else emptyList()) + missingAlt(e.children)
    }

    /** Spec §5.2: characters whose centre lies within 48 pt above or below the figure, across the page. */
    fun context(rect: PdfRect, text: String, boxes: List<PdfRect?>): String {
        val kept = text.indices.map { i ->
            val box = boxes.getOrNull(i) ?: return@map ' '
            val y = (box.bottom + box.top) / 2
            if (y >= rect.bottom - CONTEXT_MARGIN && y <= rect.top + CONTEXT_MARGIN) text[i] else ' '
        }.joinToString("")
        return kept.trim().split(Regex("\\s+")).joinToString(" ").take(CONTEXT_CHARS)
    }

    suspend fun image(page: PdfPage, rect: PdfRect): Bitmap {
        val size = page.size()
        val scale = minOf(MAX_SCALE, IMAGE_PIXELS / maxOf(rect.width, rect.height))
        val full = page.render((size.width * scale).roundToInt().coerceAtLeast(1), (size.height * scale).roundToInt().coerceAtLeast(1))
        val x0 = floor(rect.left * scale).toInt().coerceIn(0, full.width - 1)
        val y0 = floor((size.height - rect.top) * scale).toInt().coerceIn(0, full.height - 1)
        val x1 = ceil(rect.right * scale).toInt().coerceAtMost(full.width)
        val y1 = ceil((size.height - rect.bottom) * scale).toInt().coerceAtMost(full.height)
        return Bitmap.createBitmap(full, x0, y0, (x1 - x0).coerceAtLeast(1), (y1 - y0).coerceAtLeast(1)).also {
            if (it !== full) full.recycle()
        }
    }

    fun png(bitmap: Bitmap): ByteArray = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
}

suspend fun suggestAltText(ai: PdfiumAI, pages: IntRange?): PdfAltTextReview {
    val document = ai.document
    val untagged = !document.isTagged()
    val items = mutableListOf<PdfAltTextProposal>()
    var modelUsed = false
    val count = document.pageCount()

    val range = if (untagged || count == 0) IntRange.EMPTY else maxOf(0, pages?.first ?: 0)..minOf(count - 1, pages?.last ?: (count - 1))
    for (pageIndex in range) {
        val page = document.page(pageIndex)
        val figures = AltTextProposer.missingAlt(page.structure())
            .sortedWith(compareByDescending<PdfStructureElement> { it.bounds!!.top }.thenBy { it.bounds!!.left })
        if (figures.isEmpty()) continue
        val text = page.text.string()
        val boxes = text.indices.map { i -> page.text.boundingBox(i).takeIf { it.right > it.left && it.top > it.bottom } }

        for (figure in figures) {
            val rect = figure.bounds!!
            val context = AltTextProposer.context(rect, text, boxes)
            fun item(kind: PdfAltTextKind, value: String, source: PdfAiSource?) = PdfAltTextProposal(
                "$pageIndex:${figure.markedContentIds.joinToString(",")}", pageIndex, figure.markedContentIds, rect, kind, value, source, context)

            if (AltTextProposer.looksDecorative(rect)) {
                items += item(PdfAltTextKind.DECORATIVE, "", PdfAiSource.RULES)
                continue
            }
            val provider = ai.options.provider
            val androidContext = ai.options.context
            if (provider == null && androidContext == null) {
                items += item(PdfAltTextKind.DESCRIPTION, "", null)
                continue
            }
            val outcome = resolveRoutes(
                onDevice = androidContext?.let { c -> suspend {
                    val bitmap = AltTextProposer.image(page, rect)
                    try {
                        MlKitImageDescriber.describe(c, bitmap)?.let { AltTextProposer.Answer(false, it) }
                    } finally {
                        bitmap.recycle()
                    }
                } },
                customProvider = provider?.let { p -> suspend {
                    val bitmap = AltTextProposer.image(page, rect)
                    val png = try { AltTextProposer.png(bitmap) } finally { bitmap.recycle() }
                    val response = p.generate(PdfAiRequest(AltTextProposer.prompt(context), listOf(png), AltTextProposer.SCHEMA))
                    AltTextProposer.parse(response.structured ?: response.text)
                } },
            )
            if (outcome is PdfAiOutcome.Answered) {
                modelUsed = true
                val answer = outcome.result.value
                items += if (answer.decorative) item(PdfAltTextKind.DECORATIVE, "", outcome.result.source)
                else item(PdfAltTextKind.DESCRIPTION, Trial.text(answer.description), outcome.result.source)
            } else {
                items += item(PdfAltTextKind.DESCRIPTION, "", null)
            }
        }
    }
    return PdfAltTextReview(untagged, items, modelUsed, Trial.text(ALT_TEXT_NOTICE), document)
}
