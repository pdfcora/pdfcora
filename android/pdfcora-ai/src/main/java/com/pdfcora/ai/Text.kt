package com.pdfcora.ai

import com.pdfcora.PdfDocument
import com.pdfcora.PdfRect
import com.pdfcora.boundingBox

/** One page's text layer. Offsets into [text] are UTF-16, which the core's character indices count. */
data class PdfPageText(val pageIndex: Int, val text: String)

/** A retrievable piece of a page: whole sentences, with their UTF-16 range. */
data class PdfPassage(val id: String, val pageIndex: Int, val start: Int, val end: Int, val text: String)

data class PdfTextIndex(
    val pages: List<PdfPageText>,
    val passages: List<PdfPassage>,
    /** Pages with no text layer, which could not be searched (ANS-6). */
    val pagesWithoutText: List<Int>,
)

/** Passages are whole sentences up to about this many characters. */
private const val PASSAGE_CHARS = 600

internal object TextLayer {
    /** Reads each page's text layer. Pages whose text is only whitespace count as having none. */
    suspend fun readPages(document: PdfDocument, range: IntRange? = null): Pair<List<PdfPageText>, List<Int>> {
        val count = document.pageCount()
        val from = maxOf(0, range?.first ?: 0)
        val to = minOf(count - 1, range?.last ?: (count - 1))
        val pages = mutableListOf<PdfPageText>()
        val pagesWithoutText = mutableListOf<Int>()
        for (pageIndex in from..to) {
            val text = document.page(pageIndex).text.string()
            if (text.isBlank()) pagesWithoutText += pageIndex else pages += PdfPageText(pageIndex, text)
        }
        return pages to pagesWithoutText
    }

    suspend fun index(document: PdfDocument): PdfTextIndex {
        val (pages, pagesWithoutText) = readPages(document)
        return PdfTextIndex(pages, pages.flatMap(::passagesOf), pagesWithoutText)
    }

    /** Splits a page into sentence-aligned passages, keeping each one's range. */
    fun passagesOf(page: PdfPageText): List<PdfPassage> {
        val passages = mutableListOf<PdfPassage>()
        var start = -1
        var end = -1
        fun flush() {
            if (start < 0) return
            passages += PdfPassage("p${page.pageIndex}-${passages.size}", page.pageIndex, start, end,
                                   page.text.substring(start, end))
            start = -1
        }
        for (sentence in sentencesOf(page.text)) {
            if (start >= 0 && sentence.last + 1 - start > PASSAGE_CHARS) flush()
            if (start < 0) start = sentence.first
            end = sentence.last + 1
        }
        flush()
        return passages
    }

    private val boundary = Regex("""[.!?](?=\s|$)|\n\s*\n""")

    /** Sentence ranges, trimmed of surrounding whitespace. */
    fun sentencesOf(text: String): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        var cursor = 0
        fun push(from: Int, to: Int) {
            var a = from
            var b = to
            while (a < b && text[a].isWhitespace()) a++
            while (b > a && text[b - 1].isWhitespace()) b--
            if (b > a) ranges += a until b
        }
        for (match in boundary.findAll(text)) {
            val to = match.range.last + 1
            push(cursor, to)
            cursor = to
        }
        push(cursor, text.length)
        return ranges
    }

    /**
     * Rectangles covering a character range, one per line, from the core's per-character
     * boxes. Characters PDFium generates for layout have empty boxes and are skipped.
     */
    suspend fun rects(document: PdfDocument, pageIndex: Int, start: Int, end: Int): List<PdfRect> {
        val text = document.page(pageIndex).text
        val rects = mutableListOf<PdfRect>()
        for (i in start until end) {
            val box = text.boundingBox(i)
            if (box.right <= box.left || box.top <= box.bottom) continue
            val line = rects.lastOrNull()
            if (line != null && sameLine(line, box)) {
                rects[rects.size - 1] = PdfRect(minOf(line.left, box.left), minOf(line.bottom, box.bottom),
                                                maxOf(line.right, box.right), maxOf(line.top, box.top))
            } else {
                rects += box
            }
        }
        return rects
    }

    private fun sameLine(a: PdfRect, b: PdfRect): Boolean {
        val overlap = minOf(a.top, b.top) - maxOf(a.bottom, b.bottom)
        return overlap > 0.5f * minOf(a.top - a.bottom, b.top - b.bottom) && b.left >= a.left - 1
    }
}
