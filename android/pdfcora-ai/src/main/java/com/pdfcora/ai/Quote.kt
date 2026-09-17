package com.pdfcora.ai

/**
 * Finds a model's quote in the source text and returns its character range there (ANS-3).
 *
 * Tolerates what text extraction legitimately changes — runs of whitespace, line breaks,
 * and words hyphenated across a line — and nothing else. Wording, punctuation and case
 * must match, because a quote that differs in those was not copied, and a highlight built
 * from it would point at text that does not say what the answer claims.
 */
fun locateQuote(source: String, quote: String): IntRange? {
    val needle = normalise(quote, keepHyphen = true).first
    if (needle.isEmpty()) return null
    // A hyphen at a line end is either hyphenation ("manage-\nment") or a compound that
    // happens to break there ("well-\nknown"). The text cannot say which, so try both.
    for (keepHyphen in listOf(false, true)) {
        val (text, origin) = normalise(source, keepHyphen)
        val at = text.indexOf(needle)
        if (at >= 0) return origin[at]..origin[at + needle.length - 1]
    }
    return null
}

private fun normalise(text: String, keepHyphen: Boolean): Pair<String, List<Int>> {
    val out = StringBuilder()
    val origin = mutableListOf<Int>()
    var i = 0
    while (i < text.length) {
        val c = text[i]
        if (c == '­') { i++; continue }
        if (c == '-' && out.isNotEmpty() && out.last().isLetter()) {
            var j = i + 1
            while (j < text.length && (text[j] == ' ' || text[j] == '\t')) j++
            if (j < text.length && (text[j] == '\r' || text[j] == '\n')) {
                if (keepHyphen) { out.append(c); origin += i }
                while (j < text.length && text[j].isWhitespace()) j++
                i = j
                continue
            }
        }
        if (c.isWhitespace()) {
            if (out.isNotEmpty() && out.last() != ' ') { out.append(' '); origin += i }
            i++
            continue
        }
        out.append(c)
        origin += i
        i++
    }
    if (out.endsWith(" ")) {
        out.setLength(out.length - 1)
        origin.removeAt(origin.size - 1)
    }
    return out.toString() to origin
}
