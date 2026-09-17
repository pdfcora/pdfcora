package com.pdfcora.ai.redaction

import com.pdfcora.PdfDocument
import com.pdfcora.PdfDocumentSnapshot
import com.pdfcora.PdfRect
import com.pdfcora.PdfRedactionReport
import com.pdfcora.PdfRedactionTarget
import com.pdfcora.ai.*
import com.pdfcora.redact
import com.pdfcora.snapshot
import org.json.JSONObject

const val REDACTION_NOTICE = "Suggestions may be incomplete. Review the whole document."

data class PdfRedactionSuggestion(
    val id: String,
    val category: PdfRedactionCategory,
    val source: PdfAiSource,
    val pageIndex: Int,
    val start: Int,
    val end: Int,
    val text: String,
    val rects: List<PdfRect>,
)

class UnknownSuggestionException(id: String) : IllegalArgumentException("unknown suggestion: $id")

class PdfRedactionApplied internal constructor(
    val report: PdfRedactionReport,
    /** Accepted suggestions whose text is still on the page. Empty unless something went wrong. */
    val remaining: List<PdfRedactionSuggestion>,
    private val snapshot: PdfDocumentSnapshot,
) {
    /** Reopens the document as it was before apply. The host shows it and closes the redacted one. */
    suspend fun undo(): PdfDocument = snapshot.open()
}

class PdfRedactionReview internal constructor(
    val suggestions: List<PdfRedactionSuggestion>,
    /** False when no model answered, so only patterns ran. */
    val modelUsed: Boolean,
    /** Must be shown with the suggestions (RED-4). */
    val notice: String,
    val pagesWithoutText: List<Int>,
    private val document: PdfDocument,
    private val textBefore: Map<Int, String>,
) {
    suspend fun apply(accepting: List<String>): PdfRedactionApplied {
        val known = suggestions.map { it.id }.toSet()
        accepting.firstOrNull { it !in known }?.let { throw UnknownSuggestionException(it) }
        val accepted = suggestions.filter { it.id in accepting }

        val snapshot = document.snapshot()
        val report = document.redact(accepted.flatMap { s -> s.rects.map { PdfRedactionTarget.Region(it, s.pageIndex) } })

        // Offsets move once text is removed, so count occurrences instead.
        val remaining = mutableListOf<PdfRedactionSuggestion>()
        for (pageIndex in accepted.map { it.pageIndex }.toSet()) {
            val after = document.page(pageIndex).text.string()
            val before = textBefore.getValue(pageIndex)
            val onPage = accepted.filter { it.pageIndex == pageIndex }
            for (text in onPage.map { it.text }.toSet()) {
                val same = onPage.filter { it.text == text }
                if (RedactionSuggester.occurrences(text, after).size > RedactionSuggester.occurrences(text, before).size - same.size) {
                    remaining += same
                }
            }
        }
        return PdfRedactionApplied(report, remaining, snapshot)
    }
}

internal object RedactionSuggester {
    data class Item(val category: PdfRedactionCategory, val quote: String)

    fun prompt(text: String) = listOf(
        "Find personal data in the text below.",
        "Categories: personName (the name of a person, not a company), postalAddress (a street address with a postal code or city),",
        "dateOfBirth (a date the text says is a birth date), idNumber (a passport, national ID, social security or tax number).",
        "Copy each quote exactly as it appears in the text. Reply with JSON: {\"items\": [{\"category\": \"...\", \"quote\": \"...\"}]}.",
        "Reply with {\"items\": []} when there is none.",
        "",
        text,
    ).joinToString("\n")

    const val SCHEMA = """{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"category":{"type":"string","enum":["personName","postalAddress","dateOfBirth","idNumber"]},"quote":{"type":"string"}},"required":["category","quote"]}}},"required":["items"]}"""

    fun occurrences(quote: String, text: String): List<IntRange> {
        val found = mutableListOf<IntRange>()
        var offset = 0
        while (offset < text.length) {
            val at = locateQuote(text.substring(offset), quote) ?: break
            found += (offset + at.first)..(offset + at.last)
            offset += at.last + 1
        }
        return found
    }

    fun chunks(pages: List<PdfPageText>, limit: Int): List<String> {
        val chunks = mutableListOf<String>()
        for (page in pages) {
            var current = ""
            for (sentence in TextLayer.sentencesOf(page.text)) {
                val piece = page.text.substring(sentence.first, sentence.last + 1)
                if (current.isNotEmpty() && current.length + piece.length + 1 > limit) { chunks += current; current = "" }
                current = if (current.isEmpty()) piece.take(limit) else "$current $piece"
            }
            if (current.isNotEmpty()) chunks += current
        }
        return chunks
    }

    fun verified(reply: String, chunk: String, wanted: Set<PdfRedactionCategory>): List<Item> {
        val from = reply.indexOf('{')
        val to = reply.lastIndexOf('}')
        if (from < 0 || to <= from) return emptyList()
        val items = try { JSONObject(reply.substring(from, to + 1)).optJSONArray("items") } catch (e: Exception) { null } ?: return emptyList()
        return (0 until items.length()).mapNotNull { i ->
            val item = items.optJSONObject(i) ?: return@mapNotNull null
            val category = PdfRedactionCategory.MODEL.firstOrNull { it.id == item.optString("category") } ?: return@mapNotNull null
            val quote = item.optString("quote")
            if (category !in wanted || quote.trim().length < 3 || locateQuote(chunk, quote) == null) null else Item(category, quote)
        }
    }
}

suspend fun suggestRedactions(ai: PdfAI, pages: IntRange?, categories: Set<PdfRedactionCategory>?): PdfRedactionReview {
    val wanted = categories ?: PdfRedactionCategory.values().toSet()
    val document = ai.document
    val (pageTexts, pagesWithoutText) = TextLayer.readPages(document, pages)

    data class Found(val category: PdfRedactionCategory, val source: PdfAiSource, val pageIndex: Int, val start: Int, val end: Int)
    val found = mutableListOf<Found>()
    for (page in pageTexts) {
        Patterns.find(page.text, wanted.intersect(PdfRedactionCategory.PATTERNS.toSet())).forEach {
            found += Found(it.category, PdfAiSource.RULES, page.pageIndex, it.start, it.end)
        }
    }

    var modelUsed = false
    val modelWanted = wanted.intersect(PdfRedactionCategory.MODEL.toSet())
    val provider = ai.options.provider
    if (modelWanted.isNotEmpty() && provider != null) {
        val limit = (ai.options.providerContextTokens * GroundedAnswers.CHARS_PER_TOKEN * 0.6).toInt()
        val outcome = resolveRoutes(customProvider = {
            RedactionSuggester.chunks(pageTexts, limit).flatMap { chunk ->
                val response = provider.generate(PdfAiRequest(RedactionSuggester.prompt(chunk), schema = RedactionSuggester.SCHEMA))
                RedactionSuggester.verified(response.structured?.toString() ?: response.text, chunk, modelWanted)
            }
        })
        if (outcome is PdfAiOutcome.Answered) {
            modelUsed = true
            for (item in outcome.result.value) for (page in pageTexts) {
                RedactionSuggester.occurrences(item.quote, page.text).forEach {
                    found += Found(item.category, outcome.result.source, page.pageIndex, it.first, it.last + 1)
                }
            }
        }
    }

    // Patterns are deterministic, so a model suggestion that overlaps one is dropped.
    val kept = found.filter { s ->
        s.source == PdfAiSource.RULES || found.none { it.source == PdfAiSource.RULES && it.pageIndex == s.pageIndex && s.start < it.end && it.start < s.end }
    }
    val textBefore = pageTexts.associate { it.pageIndex to it.text }
    val suggestions = kept.sortedWith(compareBy({ it.pageIndex }, { it.start }))
        .distinctBy { "${it.pageIndex}:${it.start}-${it.end}:${it.category.id}" }
        .map {
            PdfRedactionSuggestion("${it.pageIndex}:${it.start}-${it.end}:${it.category.id}", it.category, it.source,
                it.pageIndex, it.start, it.end, textBefore.getValue(it.pageIndex).substring(it.start, it.end),
                TextLayer.rects(document, it.pageIndex, it.start, it.end))
        }
    return PdfRedactionReview(suggestions, modelUsed, Trial.text(REDACTION_NOTICE), pagesWithoutText, document, textBefore)
}
