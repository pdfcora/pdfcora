package com.pdfiumkit

import com.pdfiumkit.license.PdfLicenseModule
import com.pdfiumkit.writer.PdfReader
import com.pdfiumkit.writer.TagTreeWriter

/** Structure types remediation writes. [LI] blocks in a row become one list. */
enum class PdfTagType(val tag: String) {
    H1("H1"), H2("H2"), H3("H3"), H4("H4"), H5("H5"), H6("H6"), P("P"), LI("LI"), FIGURE("Figure"), ARTIFACT("Artifact")
}

/** Page objects to tag as one structure element, in reading order. [objectIndices] come from [pageObjects]. */
data class PdfTagBlock(
    val pageIndex: Int,
    val type: PdfTagType,
    val objectIndices: List<Int>,
    /** Figures only. */
    val altText: String? = null,
)

/**
 * Tags an untagged document's content as a structure tree, returning a new document. This
 * document is left unchanged.
 *
 * [blocks] are in reading order; consecutive [PdfTagType.LI] blocks become one list. Every page
 * object not in a block, and every object in an artifact block, is marked as an artifact. Throws
 * [PdfError.InvalidOperation], writing nothing, when the document is already tagged, an object
 * index is out of range or listed twice, `altText` is given for a non-figure, or there is no title
 * or language (given or already in the document). The pages are regenerated, so earlier
 * signatures stop verifying.
 *
 * @param title written to the XMP metadata; defaults to the document's title.
 * @param language BCP 47, written to /Lang; defaults to the document's own /Lang.
 */
suspend fun PdfDocument.tagContent(blocks: List<PdfTagBlock>, title: String? = null, language: String? = null): PdfDocument {
    use(PdfLicenseModule.EDITING)
    if (isTagged()) throw PdfError.InvalidOperation("the document is already tagged")
    val pageCount = pageCount()
    val objectCounts = onDocument { h -> List(pageCount) { Native.pageObjectCount(h, it) } }

    val seen = mutableSetOf<Pair<Int, Int>>()
    for (block in blocks) {
        if (block.pageIndex !in 0 until pageCount) throw PdfError.PageOutOfRange(block.pageIndex, pageCount)
        if (block.altText != null && block.type != PdfTagType.FIGURE) {
            throw PdfError.InvalidOperation("alt text is for figures, not ${block.type.tag}")
        }
        for (index in block.objectIndices) {
            if (index !in 0 until objectCounts[block.pageIndex]) throw PdfError.InvalidOperation("no object ${block.pageIndex}:$index")
            if (!seen.add(block.pageIndex to index)) throw PdfError.InvalidOperation("object ${block.pageIndex}:$index is in two blocks")
        }
    }

    val resolvedTitle = (title ?: metadata().title)?.takeIf { it.isNotEmpty() }
        ?: throw PdfError.InvalidOperation("a title is needed: the document has none")
    var base = onDocument { Native.saveDocument(it, PdfSaveMode.FULL.flag) }
    if (base.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
    if (language == null && PdfReader.entry(PdfReader.catalog(base).second, "Lang") == null) {
        throw PdfError.InvalidOperation("a language is needed: the document has no /Lang")
    }

    val mcidCounts = MutableList(pageCount) { 0 }
    val tagged = mutableListOf<TagTreeWriter.Block>()
    val marks = List(pageCount) { mutableListOf<Triple<Int, String, Int>>() }
    for (block in blocks) {
        val mcids = mutableListOf<Int>()
        for (index in block.objectIndices) {
            if (block.type == PdfTagType.ARTIFACT) {
                marks[block.pageIndex] += Triple(index, "Artifact", -1)
            } else {
                val id = mcidCounts[block.pageIndex]++
                mcids += id
                marks[block.pageIndex] += Triple(index, if (block.type == PdfTagType.LI) "LBody" else block.type.tag, id)
            }
        }
        if (block.type != PdfTagType.ARTIFACT) tagged += TagTreeWriter.Block(block.pageIndex, block.type.tag, mcids, block.altText)
    }
    for (pageIndex in 0 until pageCount) {
        for (index in 0 until objectCounts[pageIndex]) {
            if ((pageIndex to index) !in seen) marks[pageIndex] += Triple(index, "Artifact", -1)
        }
    }

    val scratch = PdfDocument.open(base)
    try {
        for ((pageIndex, list) in marks.withIndex()) {
            scratch.onDocument {
                Native.markTags(it, pageIndex, list.map { m -> m.first }.toIntArray(), list.map { m -> m.second }.toTypedArray(),
                    list.map { m -> m.third }.toIntArray())
            }
        }
        base = scratch.onDocument { Native.saveDocument(it, PdfSaveMode.FULL.flag) }
    } finally {
        scratch.close()
    }

    return PdfDocument.open(TagTreeWriter.write(base, TagTreeWriter.Tree(tagged, mcidCounts, resolvedTitle, language)))
        .also { if (needsWatermark) it.needsWatermark = true }
}
