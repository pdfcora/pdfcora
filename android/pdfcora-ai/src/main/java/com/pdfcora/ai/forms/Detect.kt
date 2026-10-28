package com.pdfcora.ai.forms

import com.pdfcora.PdfDocument
import com.pdfcora.PdfNewFormField
import com.pdfcora.PdfPageObject
import com.pdfcora.PdfPageObjectKind
import com.pdfcora.PdfRect
import com.pdfcora.addFormFields
import com.pdfcora.ai.UnknownProposalException
import com.pdfcora.boundingBox
import com.pdfcora.formFields
import com.pdfcora.pageObjects
import kotlin.math.abs

const val DETECT_NOTICE = "Check every field before it is added."

data class PdfDetectedField(
    /** `"<pageIndex>:<n>"`, n counting on the page in order. */
    val id: String,
    val pageIndex: Int,
    val kind: PdfNewFormField.Kind,
    val rect: PdfRect,
    /** Empty when no label was found. */
    val label: String,
)

class PdfDetectedFields internal constructor(
    val items: List<PdfDetectedField>,
    /** Must be shown with the proposals (HIL). */
    val notice: String,
    private val document: PdfDocument,
) {
    /** Creates the accepted fields, returning a new document; this document is unchanged. */
    suspend fun apply(accepting: List<String>): PdfDocument {
        val known = items.map { it.id }.toSet()
        accepting.firstOrNull { it !in known }?.let { throw UnknownProposalException(it) }
        val existing = mutableSetOf<String>()
        for (p in 0 until document.pageCount()) document.page(p).formFields().mapNotNullTo(existing) { it.base.name }
        val fields = items.filter { it.id in accepting }.mapIndexed { n, item ->
            val base = item.label.ifEmpty { "Field ${n + 1}" }
            var name = base
            var suffix = 2
            while (name in existing) name = "$base ${suffix++}"
            existing += name
            PdfNewFormField(item.pageIndex, item.kind, item.rect, name, item.label.ifEmpty { null })
        }
        return document.addFormFields(fields)
    }
}

/** Spec: docs/superpowers/specs/2026-09-15-flat-form-detection-design.md, function for function with the web. */
internal object FieldDetector {
    enum class Rule { UNDERSCORES, LINE, BOX, SQUARE }
    data class Candidate(val rule: Rule, val kind: PdfNewFormField.Kind, val rect: PdfRect)

    private const val FIELD_HEIGHT = 14f

    private fun intersects(a: PdfRect, b: PdfRect) = a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top

    fun candidates(objects: List<PdfPageObject>, text: String, boxes: List<PdfRect?>, widgets: List<PdfRect>): List<Candidate> {
        val found = mutableListOf<Candidate>()
        for (run in Regex("_{5,}").findAll(text)) {
            val rects = boxes.subList(run.range.first, run.range.last + 1).filterNotNull()
            if (rects.isEmpty()) continue
            val bottom = rects.minOf { it.bottom }
            found += Candidate(Rule.UNDERSCORES, PdfNewFormField.Kind.TEXT,
                PdfRect(rects.minOf { it.left }, bottom, rects.maxOf { it.right }, bottom + FIELD_HEIGHT))
        }
        val paths = objects.filter { it.kind == PdfPageObjectKind.PATH }.map { it.bounds }
        for (b in paths) if (b.width >= 40 && b.height <= 2) {
            found += Candidate(Rule.LINE, PdfNewFormField.Kind.TEXT, PdfRect(b.left, b.bottom, b.right, b.bottom + FIELD_HEIGHT))
        }
        for (b in paths) if (b.width >= 40 && b.height in 10f..40f) found += Candidate(Rule.BOX, PdfNewFormField.Kind.TEXT, b)
        for (b in paths) if (b.width in 6f..16f && b.height in 6f..16f && abs(b.width - b.height) <= 2) {
            found += Candidate(Rule.SQUARE, PdfNewFormField.Kind.CHECK_BOX, b)
        }

        fun occupied(r: PdfRect) = boxes.indices.any { i ->
            val b = boxes[i] ?: return@any false
            if (text[i] == '_' || text[i].isWhitespace()) return@any false
            val x = (b.left + b.right) / 2
            val y = (b.bottom + b.top) / 2
            x > r.left && x < r.right && y > r.bottom && y < r.top
        }

        val kept = mutableListOf<Candidate>()
        for (candidate in found) {
            if (occupied(candidate.rect) || widgets.any { intersects(it, candidate.rect) }) continue
            val clash = kept.indexOfFirst { intersects(it.rect, candidate.rect) }
            if (clash < 0) kept += candidate
            else if ((candidate.rule == Rule.BOX || candidate.rule == Rule.SQUARE) &&
                (kept[clash].rule == Rule.UNDERSCORES || kept[clash].rule == Rule.LINE)) kept[clash] = candidate
        }
        return kept
    }

    /** Spec §3 rule 8 for a checkbox: text on the same line to its right first. */
    fun rightLabel(rect: PdfRect, others: List<PdfRect>, text: String, boxes: List<PdfRect?>): String? {
        val bound = (listOf(rect.right + 250) + others.filter { it != rect && it.left >= rect.right && it.bottom < rect.top && rect.bottom < it.top }
            .map { it.left }).minOrNull()!!
        val hits = boxes.indices.filter { i ->
            val b = boxes[i] ?: return@filter false
            val centre = (b.top + b.bottom) / 2
            centre >= rect.bottom - 2 && centre <= rect.top + 2 && b.left >= rect.right - 1 && b.right <= bound
        }
        if (hits.isEmpty()) return null
        return text.substring(hits.first(), hits.last() + 1).trim().replace(Regex("[:\\s]+$"), "").ifEmpty { null }
    }
}

suspend fun detectFields(document: PdfDocument, pages: IntRange?): PdfDetectedFields {
    val items = mutableListOf<PdfDetectedField>()
    val count = document.pageCount()
    if (count > 0) {
        for (pageIndex in maxOf(0, pages?.first ?: 0)..minOf(count - 1, pages?.last ?: (count - 1))) {
            val page = document.page(pageIndex)
            val text = page.text.string()
            val boxes = text.indices.map { i -> page.text.boundingBox(i).takeIf { it.right > it.left && it.top > it.bottom } }
            val widgets = page.formFields().map { it.base.rect }
            val candidates = FieldDetector.candidates(document.pageObjects(pageIndex), text, boxes, widgets)
                .sortedWith(compareByDescending<FieldDetector.Candidate> { it.rect.top }.thenBy { it.rect.left })
            val rects = candidates.map { it.rect }
            candidates.forEachIndexed { n, c ->
                val label = (if (c.kind == PdfNewFormField.Kind.CHECK_BOX) FieldDetector.rightLabel(c.rect, rects, text, boxes) else null)
                    ?: FieldDescriber.label(c.rect, rects, text, boxes) ?: ""
                items += PdfDetectedField("$pageIndex:$n", pageIndex, c.kind, c.rect, label.trim().split(Regex("\\s+")).joinToString(" "))
            }
        }
    }
    return PdfDetectedFields(items, DETECT_NOTICE, document)
}
