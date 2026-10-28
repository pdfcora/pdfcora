package com.pdfcora.ai.remediation

import com.pdfcora.PdfDocument
import com.pdfcora.PdfPageObject
import com.pdfcora.PdfPageObjectKind
import com.pdfcora.PdfRect
import com.pdfcora.PdfTagBlock
import com.pdfcora.PdfTagType
import com.pdfcora.ai.PdfAI
import com.pdfcora.ai.UnknownProposalException
import com.pdfcora.ai.alttext.AltTextProposer
import com.pdfcora.isTagged
import com.pdfcora.pageObjects
import com.pdfcora.tagContent
import kotlin.math.abs
import kotlin.math.roundToInt

const val REMEDIATION_NOTICE = "Check every tag and the reading order before they are written."

data class PdfRemediationBlock(
    /** `"<pageIndex>:<first object index>"`. */
    val id: String,
    /** 1-based, across the document. */
    val order: Int,
    val pageIndex: Int,
    val type: PdfTagType,
    val objectIndices: List<Int>,
    val rect: PdfRect,
    /** For review; empty for figures and artifacts. */
    val text: String,
)

class PdfRemediationReview internal constructor(
    /** True when the document is tagged already: nothing is proposed. */
    val alreadyTagged: Boolean,
    val blocks: List<PdfRemediationBlock>,
    /** Must be shown with the proposals (HIL). */
    val notice: String,
    private val document: PdfDocument,
) {
    /**
     * Tags the document as proposed, with type overrides by block id, returning a new document.
     * [title] defaults to the first H1's text, else the first heading's.
     */
    suspend fun apply(types: Map<String, PdfTagType> = emptyMap(), language: String? = null, title: String? = null): PdfDocument {
        val known = blocks.map { it.id }.toSet()
        types.keys.firstOrNull { it !in known }?.let { throw UnknownProposalException(it) }
        val typed = blocks.map { it to (types[it.id] ?: it.type) }
        val headings = typed.filter { it.second.tag.matches(Regex("H[1-6]")) }
        val resolvedTitle = title ?: (headings.firstOrNull { it.second == PdfTagType.H1 } ?: headings.firstOrNull())?.first?.text
        return document.tagContent(typed.map { PdfTagBlock(it.first.pageIndex, it.second, it.first.objectIndices) }, resolvedTitle, language)
    }
}

/** Spec §4.2 of `2026-09-15-remediation-design.md`, function for function with the web. */
internal object RemediationRules {
    private const val HEADING_RATIO = 1.2f
    private const val HEADING_CHARS = 200
    private val LIST_MARKER = Regex("""^(?:[•◦▪‣\-–*]\s|(?:\d{1,3}|[A-Za-z])[.)]\s)""")

    class Draft(val pageIndex: Int, var type: PdfTagType, val objects: MutableList<PdfPageObject>, var rect: PdfRect, val size: Float, var text: String)

    private class Line(val objects: MutableList<PdfPageObject>, var rect: PdfRect, val size: Float, var text: String)

    fun startsWithListMarker(text: String) = LIST_MARKER.containsMatchIn(text)

    private fun union(a: PdfRect, b: PdfRect) =
        PdfRect(minOf(a.left, b.left), minOf(a.bottom, b.bottom), maxOf(a.right, b.right), maxOf(a.top, b.top))

    fun pageBlocks(pageIndex: Int, objects: List<PdfPageObject>): List<Draft> {
        val blocks = mutableListOf<Draft>()
        var line: Line? = null
        var block: Draft? = null

        fun closeLine() {
            val current = line ?: return
            line = null
            val b = block
            if (b != null && blocks.lastOrNull() === b && abs(b.size - current.size) <= 0.5f &&
                b.rect.bottom - current.rect.top <= current.size / 2 && abs(b.rect.left - current.rect.left) <= current.size &&
                !startsWithListMarker(current.text)) {
                b.objects += current.objects
                b.rect = union(b.rect, current.rect)
                b.text = "${b.text} ${current.text}"
            } else {
                block = Draft(pageIndex, PdfTagType.P, current.objects.toMutableList(), current.rect, current.size, current.text)
                blocks += block!!
            }
        }

        for (obj in objects) {
            val text = obj.text?.trim().orEmpty()
            if (obj.kind == PdfPageObjectKind.TEXT && text.isEmpty()) continue
            if (obj.kind != PdfPageObjectKind.TEXT) {
                closeLine()
                block = null
                val figure = (obj.kind == PdfPageObjectKind.IMAGE || obj.kind == PdfPageObjectKind.FORM) && !AltTextProposer.looksDecorative(obj.bounds)
                blocks += Draft(pageIndex, if (figure) PdfTagType.FIGURE else PdfTagType.ARTIFACT, mutableListOf(obj), obj.bounds, 0f, "")
                continue
            }
            val size = obj.fontSize ?: 0f
            val b = obj.bounds
            val l = line
            if (l != null && abs(l.size - size) <= 0.5f &&
                minOf(l.rect.top, b.top) - maxOf(l.rect.bottom, b.bottom) >= minOf(l.rect.top - l.rect.bottom, b.top - b.bottom) / 2 &&
                b.left >= l.rect.right - size) {
                l.objects += obj
                l.rect = union(l.rect, b)
                l.text = "${l.text} $text"
            } else {
                closeLine()
                line = Line(mutableListOf(obj), b, size, text)
            }
        }
        closeLine()
        return blocks
    }

    fun typeBlocks(drafts: List<Draft>) {
        fun rounded(size: Float) = (size * 2).roundToInt() / 2f
        val characters = mutableMapOf<Float, Int>()
        for (d in drafts) if (d.type == PdfTagType.P) for (o in d.objects) {
            val key = rounded(o.fontSize ?: 0f)
            characters[key] = (characters[key] ?: 0) + (o.text?.length ?: 0)
        }
        val body = characters.entries.sortedWith(compareByDescending<Map.Entry<Float, Int>> { it.value }.thenBy { it.key }).firstOrNull()?.key ?: 0f
        fun isHeading(d: Draft) = body > 0 && d.size >= body * HEADING_RATIO && d.text.length <= HEADING_CHARS

        val headingSizes = drafts.filter { it.type == PdfTagType.P && !startsWithListMarker(it.text) && isHeading(it) }
            .map { rounded(it.size) }.distinct().sortedDescending()
        val levels = listOf(PdfTagType.H1, PdfTagType.H2, PdfTagType.H3, PdfTagType.H4, PdfTagType.H5, PdfTagType.H6)
        for (d in drafts) {
            if (d.type != PdfTagType.P) continue
            if (startsWithListMarker(d.text)) d.type = PdfTagType.LI
            else if (isHeading(d)) d.type = levels[minOf(5, headingSizes.indexOf(rounded(d.size)))]
        }

        // PDF/UA 7.4.2: the first heading must be H1 and no level may be skipped. Sizes
        // alone break that whenever the largest text is not the first heading — a page
        // number set large, a table's total — which real documents do often.
        var previous = 0
        for (d in drafts) {
            val rank = levels.indexOf(d.type)
            if (rank < 0) continue
            previous = minOf(rank + 1, previous + 1)
            d.type = levels[previous - 1]
        }
    }
}

suspend fun suggestRemediation(ai: PdfAI, pages: IntRange?): PdfRemediationReview {
    val document = ai.document
    val alreadyTagged = document.isTagged()
    val count = document.pageCount()
    val drafts = mutableListOf<RemediationRules.Draft>()
    if (!alreadyTagged && count > 0) {
        for (pageIndex in maxOf(0, pages?.first ?: 0)..minOf(count - 1, pages?.last ?: (count - 1))) {
            drafts += RemediationRules.pageBlocks(pageIndex, document.pageObjects(pageIndex))
        }
    }
    RemediationRules.typeBlocks(drafts)
    val blocks = drafts.mapIndexed { i, d ->
        PdfRemediationBlock("${d.pageIndex}:${d.objects[0].index}", i + 1, d.pageIndex, d.type, d.objects.map { it.index }, d.rect, d.text)
    }
    return PdfRemediationReview(alreadyTagged, blocks, REMEDIATION_NOTICE, document)
}
