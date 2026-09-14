package com.pdfiumkit.ai

enum class PdfSummaryStyle { PARAGRAPH, KEY_POINTS }

data class PdfSummary(val text: String, val pagesWithoutText: List<Int>)

internal object SummaryText {
    /**
     * Summarises text of any length with a summariser that accepts at most [limit]
     * characters at a time (SUM-2). Pages are packed into parts that fit, each part is
     * summarised, and the summaries are combined the same way until one call covers
     * everything.
     */
    suspend fun summarise(pages: List<String>, limit: Int, summarise: suspend (String) -> String): String {
        var parts = pack(pages.flatMap { split(it, limit) }, limit)
        if (parts.isEmpty()) return ""
        while (parts.size > 1) {
            val summaries = parts.map { summarise(it) }
            val next = pack(summaries.flatMap { split(it, limit) }, limit)
            // Summaries that no longer shrink would loop forever.
            if (next.joinToString("").length >= parts.joinToString("").length) {
                parts = listOf(next.joinToString("\n\n").take(limit))
                break
            }
            parts = next
        }
        return summarise(parts[0])
    }

    private fun pack(pieces: List<String>, limit: Int): List<String> {
        val parts = mutableListOf<String>()
        var current = ""
        for (piece in pieces) {
            val joined = if (current.isEmpty()) piece else "$current\n\n$piece"
            if (joined.length <= limit) {
                current = joined
            } else {
                if (current.isNotEmpty()) parts += current
                current = piece
            }
        }
        if (current.isNotEmpty()) parts += current
        return parts
    }

    private fun split(text: String, limit: Int): List<String> {
        if (text.length <= limit) return if (text.isBlank()) emptyList() else listOf(text)
        val pieces = mutableListOf<String>()
        for (sentence in TextLayer.sentencesOf(text)) {
            var at = sentence.first
            while (at <= sentence.last) {
                val end = minOf(sentence.last + 1, at + limit)
                pieces += text.substring(at, end)
                at = end
            }
        }
        return pieces
    }

    fun prompt(text: String, style: PdfSummaryStyle): String = listOf(
        if (style == PdfSummaryStyle.KEY_POINTS)
            "Summarise the text below as key points, one per line, each starting with \"- \"."
        else "Summarise the text below as one short paragraph.",
        "Use only what the text says.",
        "",
        text,
    ).joinToString("\n")
}
