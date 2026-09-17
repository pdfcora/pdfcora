package com.pdfcora.ai.forms

import com.pdfcora.PdfDocument
import com.pdfcora.PdfFormField
import com.pdfcora.PdfRect
import com.pdfcora.boundingBox
import com.pdfcora.formFields

internal data class PdfFieldDescription(
    val pageIndex: Int,
    val field: PdfFormField,
    /** Page text next to the field (FORM-1). */
    val label: String?,
)

internal object FieldDescriber {
    /** Every form field on the pages in scope, with the label printed next to it. */
    suspend fun describe(document: PdfDocument, pages: IntRange?): List<PdfFieldDescription> {
        val count = document.pageCount()
        if (count == 0) return emptyList()
        val described = mutableListOf<PdfFieldDescription>()
        for (pageIndex in maxOf(0, pages?.first ?: 0)..minOf(count - 1, pages?.last ?: (count - 1))) {
            val page = document.page(pageIndex)
            val fields = page.formFields()
            if (fields.isEmpty()) continue
            val text = page.text.string()
            val boxes = (text.indices).map { i ->
                page.text.boundingBox(i).takeIf { it.right > it.left && it.top > it.bottom }
            }
            for (field in fields) {
                described += PdfFieldDescription(pageIndex, field, label(field.base.rect, fields.map { it.base.rect }, text, boxes))
            }
        }
        return described
    }

    /** Spec §4: text on the field's line to its left, else just above it. */
    fun label(rect: PdfRect, others: List<PdfRect>, text: String, boxes: List<PdfRect?>): String? {
        val low = minOf(rect.bottom, rect.top); val high = maxOf(rect.bottom, rect.top)
        val left = minOf(rect.left, rect.right); val right = maxOf(rect.left, rect.right)
        val bound = (listOf(left - 250f) + others.filter { o ->
            o != rect && maxOf(o.left, o.right) <= left && minOf(o.bottom, o.top) < high && low < maxOf(o.bottom, o.top)
        }.map { maxOf(it.left, it.right) }).max()
        val onLine = { b: PdfRect ->
            val centre = (b.top + b.bottom) / 2
            centre >= low - 2 && centre <= high + 2 && b.right <= left + 1 && b.left >= bound
        }
        val above = { b: PdfRect -> b.bottom >= high && b.bottom - high <= 14 && b.right > left && b.left < right }
        for (accept in listOf(onLine, above)) {
            val hits = boxes.indices.filter { boxes[it]?.let(accept) == true }
            if (hits.isEmpty()) continue
            val label = text.substring(hits.first(), hits.last() + 1).trim().replace(Regex("[:\\s]+$"), "")
            if (label.isNotEmpty()) return label
        }
        return null
    }
}
