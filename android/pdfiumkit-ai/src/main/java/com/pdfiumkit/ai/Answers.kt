package com.pdfiumkit.ai

import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfRect
import org.json.JSONObject

/** A sentence in the document that supports an answer (ANS-5). */
data class PdfCitation(
    val pageIndex: Int,
    /** Character range in the page's text layer, end exclusive. */
    val start: Int,
    val end: Int,
    val rects: List<PdfRect>,
    /** The source text the range covers, not the model's copy of it. */
    val quote: String,
)

sealed class PdfAnswer {
    data class Answered(
        val text: String,
        val citations: List<PdfCitation>,
        /** False when any quote the model gave could not be found in the document (ANS-3). */
        val grounded: Boolean,
        val pagesWithoutText: List<Int>,
    ) : PdfAnswer()

    data class NotFound(val pagesWithoutText: List<Int>) : PdfAnswer()
}

/** What the model is asked to return (ANS-2). */
data class PdfGroundedReply(val answer: String, val citations: List<Citation>) {
    data class Citation(val passage: String, val quote: String)
}

internal object GroundedAnswers {
    const val MAX_CITATIONS = 3

    /** Characters per token, deliberately low so a prompt never overruns the budget. */
    const val CHARS_PER_TOKEN = 3

    const val SCHEMA = """{"type":"object","properties":{"answer":{"type":"string"},"citations":{"type":"array",""" +
        """"maxItems":3,"items":{"type":"object","properties":{"passage":{"type":"string"},"quote":{"type":"string"}},""" +
        """"required":["passage","quote"]}}},"required":["answer","citations"]}"""

    fun passages(index: PdfTextIndex, question: String, contextTokens: Int): List<PdfPassage> =
        Retrieval.retrieve(index.passages, question, (contextTokens * CHARS_PER_TOKEN * 0.6).toInt())

    fun prompt(question: String, passages: List<PdfPassage>): String = (listOf(
        "Answer the question using only the passages below.",
        "Support the answer with up to $MAX_CITATIONS citations. Each citation names a passage id and",
        "quotes one sentence from that passage word for word.",
        "If the passages do not answer the question, reply with an empty answer and no citations.",
        "",
        "Passages:",
    ) + passages.map {
        // One line per passage: the page's own line breaks would blur where it ends.
        "[${it.id}] (page ${it.pageIndex + 1}) ${it.text.replace(Regex("""\s+"""), " ")}"
    } + listOf("", "Question: $question")).joinToString("\n")

    /** Reads a reply from structured JSON, or from text holding JSON. Null if neither parses. */
    fun parse(structured: String?, text: String): PdfGroundedReply? {
        val json = (structured ?: text).trim()
            .replace(Regex("""^```(?:json)?\s*""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\s*```$"""), "")
        val obj = try {
            JSONObject(json)
        } catch (e: Exception) {
            return null
        }
        val answer = obj.opt("answer") as? String ?: return null
        val citations = obj.optJSONArray("citations") ?: return null
        return PdfGroundedReply(answer, (0 until citations.length()).mapNotNull { i ->
            val c = citations.optJSONObject(i) ?: return@mapNotNull null
            val passage = c.opt("passage") as? String ?: return@mapNotNull null
            val quote = c.opt("quote") as? String ?: return@mapNotNull null
            PdfGroundedReply.Citation(passage, quote)
        }.take(MAX_CITATIONS))
    }

    /**
     * Turns a reply into an answer whose highlights come only from verified quotes. A quote
     * is looked for in the passage it names, and only there. Coordinates never come from
     * the model.
     */
    suspend fun verify(
        reply: PdfGroundedReply, document: PdfDocument, index: PdfTextIndex, passages: List<PdfPassage>,
    ): PdfAnswer {
        if (reply.answer.isBlank() && reply.citations.isEmpty()) return PdfAnswer.NotFound(index.pagesWithoutText)
        val byId = passages.associateBy { it.id }
        val citations = mutableListOf<PdfCitation>()
        for (cited in reply.citations) {
            val passage = byId[cited.passage] ?: continue
            val found = locateQuote(passage.text, cited.quote) ?: continue
            val start = passage.start + found.first
            val end = passage.start + found.last + 1
            val page = index.pages.first { it.pageIndex == passage.pageIndex }
            citations += PdfCitation(passage.pageIndex, start, end,
                                     TextLayer.rects(document, passage.pageIndex, start, end),
                                     page.text.substring(start, end))
        }
        return PdfAnswer.Answered(reply.answer, citations,
                                  citations.isNotEmpty() && citations.size == reply.citations.size,
                                  index.pagesWithoutText)
    }
}
