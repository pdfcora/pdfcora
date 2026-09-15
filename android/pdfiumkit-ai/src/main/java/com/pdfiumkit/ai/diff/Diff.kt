package com.pdfiumkit.ai.diff

import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfRect
import com.pdfiumkit.ai.*
import org.json.JSONObject

const val DIFF_NOTICE = "Check the differences against both documents."

data class PdfDiffSide(val pageIndex: Int, val start: Int, val end: Int, val text: String, val rects: List<PdfRect>)

enum class PdfDiffKind { MODIFIED, ADDED, REMOVED }
enum class PdfDiffLabel { MEANING_CHANGED, WORDING_ONLY, UNCLASSIFIED }

data class PdfDiffChange(
    /** `"c<n>"`, in order. */
    val id: String,
    val kind: PdfDiffKind,
    val label: PdfDiffLabel,
    val summary: String?,
    /** Null for added sentences. */
    val original: PdfDiffSide?,
    /** Null for removed sentences. */
    val revised: PdfDiffSide?,
    val source: PdfAiSource,
)

/** [notice] must be shown with the changes. */
data class PdfDiff(val changes: List<PdfDiffChange>, val modelUsed: Boolean, val notice: String)

/** Spec: docs/superpowers/specs/2026-09-15-semantic-diff-design.md, function for function with the web. */
internal object DiffAligner {
    sealed class Alignment {
        data class Modified(val original: Int, val revised: Int) : Alignment()
        data class Removed(val original: Int) : Alignment()
        data class Added(val revised: Int) : Alignment()
    }

    private const val THRESHOLD = 0.3

    fun normalise(text: String): String = text.lowercase()
        .replace(Regex("[‘’]"), "'").replace(Regex("[“”]"), "\"").replace(Regex("[–—]"), "-")
        .trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

    fun similarity(a: String, b: String): Double {
        fun grams(text: String): Set<String> {
            val points = normalise(text).codePoints().toArray()
            return (0..points.size - 3).map { String(points, it, 3) }.toSet()
        }
        val x = grams(a)
        val y = grams(b)
        if (x.size + y.size == 0) return 0.0
        return 2.0 * x.intersect(y).size / (x.size + y.size)
    }

    fun align(original: List<String>, revised: List<String>): List<Alignment> {
        val a = original.map(::normalise)
        val b = revised.map(::normalise)
        val lcs = Array(a.size + 1) { IntArray(b.size + 1) }
        for (i in a.indices.reversed()) for (j in b.indices.reversed()) {
            lcs[i][j] = if (a[i] == b[j]) lcs[i + 1][j + 1] + 1 else maxOf(lcs[i + 1][j], lcs[i][j + 1])
        }
        val anchors = mutableListOf<Pair<Int, Int>>()
        var i = 0
        var j = 0
        while (i < a.size && j < b.size) {
            when {
                a[i] == b[j] -> { anchors += i to j; i++; j++ }
                lcs[i + 1][j] >= lcs[i][j + 1] -> i++
                else -> j++
            }
        }
        anchors += a.size to b.size

        val result = mutableListOf<Alignment>()
        i = 0
        j = 0
        for ((ai, bj) in anchors) {
            val gapA = (i until ai).toList()
            val gapB = (j until bj).toList()
            fun text(list: List<String>, gap: List<Int>, k: Int) = if (k < gap.size) list[gap[k]] else ""
            var x = 0
            var y = 0
            while (x < gapA.size && y < gapB.size) {
                when {
                    similarity(text(original, gapA, x), text(revised, gapB, y)) >= THRESHOLD ->
                        result += Alignment.Modified(gapA[x++], gapB[y++])
                    similarity(text(revised, gapB, y), text(original, gapA, x + 1)) >=
                        similarity(text(original, gapA, x), text(revised, gapB, y + 1)) -> result += Alignment.Removed(gapA[x++])
                    else -> result += Alignment.Added(gapB[y++])
                }
            }
            while (x < gapA.size) result += Alignment.Removed(gapA[x++])
            while (y < gapB.size) result += Alignment.Added(gapB[y++])
            i = ai + 1
            j = bj + 1
        }
        return result
    }

    const val SCHEMA = """{"type":"object","properties":{"label":{"type":"string","enum":["meaningChanged","wordingOnly"]},"summary":{"type":"string"}},"required":["label","summary"]}"""

    fun prompt(original: String, revised: String): String = listOf(
        "Two versions of a sentence from a document follow.",
        "Decide whether the revision changes the meaning — what is required, allowed or promised, or any number, date, name or amount — or only the wording.",
        "Reply with JSON: {\"label\": \"meaningChanged\" or \"wordingOnly\", \"summary\": \"...\"}.",
        "For meaningChanged, the summary is one sentence describing the change in meaning, in the language of the sentences; for wordingOnly it is empty.",
        "Original: ${JSONObject.quote(original)}",
        "Revised: ${JSONObject.quote(revised)}",
    ).joinToString("\n")

    data class Answer(val label: PdfDiffLabel, val summary: String)

    fun parse(text: String): Answer? {
        val from = text.indexOf('{')
        val to = text.lastIndexOf('}')
        if (from < 0 || to < from) return null
        val json = runCatching { JSONObject(text.substring(from, to + 1)) }.getOrNull() ?: return null
        val label = when (json.optString("label")) {
            "meaningChanged" -> PdfDiffLabel.MEANING_CHANGED
            "wordingOnly" -> PdfDiffLabel.WORDING_ONLY
            else -> return null
        }
        return Answer(label, json.optString("summary", "").trim())
    }
}

private data class Sentence(val pageIndex: Int, val start: Int, val end: Int, val text: String)

private suspend fun sentences(document: PdfDocument, pages: IntRange?): List<Sentence> =
    TextLayer.readPages(document, pages).first.flatMap { page ->
        TextLayer.sentencesOf(page.text).map { Sentence(page.pageIndex, it.first, it.last + 1, page.text.substring(it.first, it.last + 1)) }
    }

suspend fun compareDocuments(ai: PdfiumAI, revised: PdfDocument, pages: IntRange?, revisedPages: IntRange?): PdfDiff {
    val document = ai.document
    val before = sentences(document, pages)
    val after = sentences(revised, revisedPages)
    suspend fun side(doc: PdfDocument, s: Sentence) =
        PdfDiffSide(s.pageIndex, s.start, s.end, s.text, TextLayer.rects(doc, s.pageIndex, s.start, s.end))
    val provider = ai.options.provider

    var modelUsed = false
    val changes = mutableListOf<PdfDiffChange>()
    for (item in DiffAligner.align(before.map { it.text }, after.map { it.text })) {
        val id = "c${changes.size + 1}"
        when (item) {
            is DiffAligner.Alignment.Removed -> changes += PdfDiffChange(id, PdfDiffKind.REMOVED, PdfDiffLabel.MEANING_CHANGED, null,
                side(document, before[item.original]), null, PdfAiSource.RULES)
            is DiffAligner.Alignment.Added -> changes += PdfDiffChange(id, PdfDiffKind.ADDED, PdfDiffLabel.MEANING_CHANGED, null,
                null, side(revised, after[item.revised]), PdfAiSource.RULES)
            is DiffAligner.Alignment.Modified -> {
                val original = side(document, before[item.original])
                val changed = side(revised, after[item.revised])
                val outcome = provider?.let { p ->
                    resolveRoutes(customProvider = {
                        val response = p.generate(PdfAiRequest(DiffAligner.prompt(original.text, changed.text), schema = DiffAligner.SCHEMA))
                        DiffAligner.parse(response.structured ?: response.text)
                    })
                }
                if (outcome is PdfAiOutcome.Answered) {
                    modelUsed = true
                    val answer = outcome.result.value
                    val summary = if (answer.label == PdfDiffLabel.MEANING_CHANGED && answer.summary.isNotEmpty()) Trial.text(answer.summary) else null
                    changes += PdfDiffChange(id, PdfDiffKind.MODIFIED, answer.label, summary, original, changed, outcome.result.source)
                } else {
                    changes += PdfDiffChange(id, PdfDiffKind.MODIFIED, PdfDiffLabel.UNCLASSIFIED, null, original, changed, PdfAiSource.RULES)
                }
            }
        }
    }
    return PdfDiff(changes, modelUsed, Trial.text(DIFF_NOTICE))
}
