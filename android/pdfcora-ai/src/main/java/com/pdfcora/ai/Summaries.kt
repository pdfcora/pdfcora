package com.pdfcora.ai

enum class PdfSummaryStyle { PARAGRAPH, KEY_POINTS }

data class PdfSummary(val text: String, val pagesWithoutText: List<Int>)

internal object SummaryText {
    private const val EARLIER = "Summary of the earlier parts:\n"
    private const val NEXT = "\n\nNext part:\n"

    /**
     * Summarises text of any length with a summariser that accepts at most [limit]
     * characters at a time (SUM-2), reading it in windows.
     *
     * The first window is plain text. Each later window carries the summary so far followed
     * by the next stretch of text, so each part is summarised knowing what came before, and
     * the last summary covers the whole document. Text is split at sentences into pieces of
     * at most a quarter of the limit, and a summary that would leave no room for a piece is
     * condensed first — and cut, if condensing does not shrink it enough.
     *
     * [minimum] is for a summariser that refuses short input — ML Kit rejects articles under
     * 400 characters. Null when the whole text is shorter, so the caller's next route answers
     * instead; a window that would be shorter is not sent, and its text is kept after the
     * summary as it is.
     */
    suspend fun summariseInWindows(
        pages: List<String>, limit: Int, minimum: Int = 0, summarise: suspend (String) -> String,
    ): String? {
        if (minimum > 0 && pages.sumOf { it.length } < minimum) return null
        val pieceLength = maxOf(1, limit / 4)
        val pieces = pages.flatMap { split(it, pieceLength) }
        val labels = EARLIER.length + NEXT.length
        var summary: String? = null
        var index = 0

        while (index < pieces.size) {
            summary?.let { current ->
                if (labels + current.length + pieceLength > limit) {
                    val condensed = if (current.length < minimum) current else collapseBullets(summarise(current.take(limit)))
                    summary = condensed.take(maxOf(0, limit - labels - pieceLength))
                }
            }
            val room = limit - (summary?.let { labels + it.length } ?: 0)
            var window = ""
            while (index < pieces.size) {
                val joined = if (window.isEmpty()) pieces[index] else "$window\n\n${pieces[index]}"
                if (joined.length > room) break
                window = joined
                index++
            }
            val input = summary?.let { "$EARLIER$it$NEXT$window" } ?: window
            summary = if (input.length < minimum) summary?.let { "$it\n\n$window" } ?: window else collapseBullets(summarise(input))
        }
        return summary ?: ""
    }

    /**
     * Given a bulleted summary to carry forward, a model may bullet its lines again: Apple's
     * returns "- - point". Two or more markers opening a line become one.
     */
    private val repeatedBullets = Regex("""^[ \t]*(?:[-*•][ \t]+){2,}""", RegexOption.MULTILINE)

    private fun collapseBullets(text: String): String = repeatedBullets.replace(text, "- ")

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
