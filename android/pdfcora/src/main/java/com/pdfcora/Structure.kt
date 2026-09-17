package com.pdfcora

import com.pdfcora.license.PdfLicenseModule
import com.pdfcora.writer.FigureWriter

/** An element of a tagged PDF's structure tree, as seen from one page. */
data class PdfStructureElement(
    /** The structure type as written (`/S`), such as `P`, `H1` or `Figure`; role maps are not applied. */
    val type: String,
    val altText: String?,
    val actualText: String?,
    val title: String?,
    val language: String?,
    /** Marked-content ids of this element's own content on the page. */
    val markedContentIds: List<Int>,
    /** Union of the page objects carrying this element's or its descendants' content. */
    val bounds: PdfRect?,
    val children: List<PdfStructureElement>,
)

/** A figure, named by its page and marked-content ids, and what to write for it. */
sealed class PdfFigureEdit {
    abstract val pageIndex: Int
    abstract val markedContentIds: List<Int>

    data class AltText(override val pageIndex: Int, override val markedContentIds: List<Int>, val text: String) : PdfFigureEdit()
    data class Decorative(override val pageIndex: Int, override val markedContentIds: List<Int>) : PdfFigureEdit()
}

/** True when the document declares itself tagged (`/MarkInfo /Marked`). */
suspend fun PdfDocument.isTagged(): Boolean = onDocument { Native.isTagged(it) }

/**
 * The page's structure tree: the elements of a tagged PDF that have content on this page.
 * Empty for an untagged document.
 */
suspend fun PdfPage.structure(): List<PdfStructureElement> = document.onDocument { h ->
    val bounds = mutableMapOf<Int, PdfRect>()
    Native.pageObjectMarkedContentIds(h, index).forEachIndexed { objectIndex, id ->
        if (id < 0) return@forEachIndexed
        val v = Native.pageObjectBounds(h, index, objectIndex)
        val rect = PdfRect(minOf(v[0], v[2]), minOf(v[1], v[3]), maxOf(v[0], v[2]), maxOf(v[1], v[3]))
        bounds[id] = bounds[id]?.let { union(it, rect) } ?: rect
    }

    val packed = Native.structure(h, index)
    val numbers = packed[0] as IntArray
    @Suppress("UNCHECKED_CAST") val strings = packed[1] as Array<String>
    var n = 0
    var s = 0

    // Pre-order with depths: an element's children are the following elements one level deeper.
    fun read(depth: Int): PdfStructureElement {
        n++                                               // the depth, already known
        val ids = List(numbers[n++]) { numbers[n++] }
        val texts = List(5) { strings[s++].ifEmpty { null } }
        val children = mutableListOf<PdfStructureElement>()
        while (n < numbers.size && numbers[n] == depth + 1) children += read(depth + 1)
        val rect = (ids.mapNotNull { bounds[it] } + children.mapNotNull { it.bounds }).reduceOrNull(::union)
        return PdfStructureElement(texts[0] ?: "", texts[1], texts[2], texts[3], texts[4], ids, rect, children)
    }

    val roots = mutableListOf<PdfStructureElement>()
    while (n < numbers.size) roots += read(0)
    roots
}

private fun union(a: PdfRect, b: PdfRect) =
    PdfRect(minOf(a.left, b.left), minOf(a.bottom, b.bottom), maxOf(a.right, b.right), maxOf(a.top, b.top))

/**
 * Writes alternate text for figures, or marks them decorative, returning a new document.
 * This document is left unchanged.
 *
 * A figure is named by its page and marked-content ids, as [structure] reports them. Every
 * edit is checked first; one that matches no figure, or several, throws
 * [PdfError.InvalidOperation] and nothing is written. Decorative figures have their content
 * re-marked as an artifact and are removed from the structure tree; that regenerates the
 * page, so earlier signatures stop verifying. Description-only edits are appended as an
 * incremental update.
 */
suspend fun PdfDocument.updateFigures(edits: List<PdfFigureEdit>): PdfDocument {
    use(PdfLicenseModule.EDITING)
    val pages = pageCount()
    edits.firstOrNull { it.pageIndex !in 0 until pages }?.let { throw PdfError.PageOutOfRange(it.pageIndex, pages) }
    val writes = edits.map {
        FigureWriter.Edit(it.pageIndex, it.markedContentIds, (it as? PdfFigureEdit.AltText)?.text, it is PdfFigureEdit.Decorative)
    }
    val decorative = writes.filter { it.decorative }

    try {
        var base = onDocument { Native.saveDocument(it, if (decorative.isEmpty()) PdfSaveMode.INCREMENTAL.flag else PdfSaveMode.FULL.flag) }
        if (base.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
        FigureWriter.find(base, writes)

        if (decorative.isNotEmpty()) {
            val scratch = PdfDocument.open(base)
            try {
                for ((pageIndex, group) in decorative.groupBy { it.pageIndex }) {
                    val ids = group.flatMap { it.markedContentIds }.distinct().toIntArray()
                    scratch.onDocument { Native.markArtifacts(it, pageIndex, ids) }
                }
                base = scratch.onDocument { Native.saveDocument(it, PdfSaveMode.FULL.flag) }
            } finally {
                scratch.close()
            }
        }

        return PdfDocument.open(FigureWriter.write(base, writes)).also { if (needsWatermark) it.needsWatermark = true }
    } catch (e: FigureWriter.NotFound) {
        throw PdfError.InvalidOperation(e.message ?: "no such figure")
    }
}
