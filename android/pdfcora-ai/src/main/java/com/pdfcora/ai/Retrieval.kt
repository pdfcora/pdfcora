package com.pdfcora.ai

import kotlin.math.ln

internal object Retrieval {
    private val word = Regex("""[\p{L}\p{N}]+""")

    /** Lower-cased letter and digit runs. Diacritics are kept: "Straße" is not "Strasse". */
    fun tokens(text: String): List<String> = word.findAll(text.lowercase()).map { it.value }.toList()

    /**
     * Ranks passages against a question with BM25, on the device and without a model
     * (ANS-1). Returns only passages sharing a term with the question, best first, and
     * stops before their combined text would exceed [budget] characters.
     */
    fun retrieve(passages: List<PdfPassage>, question: String, budget: Int): List<PdfPassage> {
        val k1 = 1.2
        val b = 0.75
        val terms = tokens(question).distinct()
        if (terms.isEmpty() || passages.isEmpty()) return emptyList()

        val docs = passages.map { tokens(it.text) }
        val averageLength = (docs.sumOf { it.size }.toDouble() / docs.size).takeIf { it > 0 } ?: 1.0
        val documentFrequency = mutableMapOf<String, Int>()
        for (doc in docs) for (term in doc.toSet()) documentFrequency[term] = (documentFrequency[term] ?: 0) + 1

        val scored = passages.indices.map { i ->
            val doc = docs[i]
            var score = 0.0
            for (term in terms) {
                val frequency = doc.count { it == term }.toDouble()
                if (frequency == 0.0) continue
                val n = (documentFrequency[term] ?: 0).toDouble()
                val idf = ln(1 + (passages.size - n + 0.5) / (n + 0.5))
                score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * doc.size / averageLength))
            }
            passages[i] to score
        }

        val picked = mutableListOf<PdfPassage>()
        var used = 0
        // sortedByDescending is stable, so equal scores keep document order as on the web.
        for ((passage, _) in scored.filter { it.second > 0 }.sortedByDescending { it.second }) {
            if (used + passage.text.length > budget) break
            picked += passage
            used += passage.text.length
        }
        return picked
    }
}
