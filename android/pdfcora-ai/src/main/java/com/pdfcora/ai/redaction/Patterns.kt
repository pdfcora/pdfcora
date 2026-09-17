package com.pdfcora.ai.redaction

enum class PdfRedactionCategory(val id: String) {
    IBAN("iban"), EMAIL("email"), PHONE("phone"), PAYMENT_CARD("paymentCard"), DATE("date"), URL("url"),
    IP_ADDRESS("ipAddress"), PERSON_NAME("personName"), POSTAL_ADDRESS("postalAddress"),
    DATE_OF_BIRTH("dateOfBirth"), ID_NUMBER("idNumber");

    companion object {
        /** Found by pattern, in tie-break order. */
        val PATTERNS = listOf(IBAN, EMAIL, PHONE, PAYMENT_CARD, DATE, URL, IP_ADDRESS)
        /** Found by a model. */
        val MODEL = listOf(PERSON_NAME, POSTAL_ADDRESS, DATE_OF_BIRTH, ID_NUMBER)
    }
}

internal data class PatternMatch(val category: PdfRedactionCategory, val start: Int, val end: Int)

/**
 * Personal data found by pattern alone (RED-1). Behaviour is pinned by
 * conformance/redaction/patterns.json, which every platform runs.
 */
internal object Patterns {
    private val MONTHS = mapOf(
        "January" to 1, "February" to 2, "March" to 3, "April" to 4, "May" to 5, "June" to 6, "July" to 7,
        "August" to 8, "September" to 9, "October" to 10, "November" to 11, "December" to 12,
        "Januar" to 1, "Februar" to 2, "März" to 3, "Mai" to 5, "Juni" to 6, "Juli" to 7, "Oktober" to 10,
        "Dezember" to 12, "Sept" to 9, "Jan" to 1, "Feb" to 2, "Mar" to 3, "Mär" to 3, "Apr" to 4, "Jun" to 6,
        "Jul" to 7, "Aug" to 8, "Sep" to 9, "Oct" to 10, "Okt" to 10, "Nov" to 11, "Dec" to 12, "Dez" to 12, "Jän" to 1,
    )
    private val MONTH = MONTHS.keys.sortedByDescending { it.length }.joinToString("|")
    private const val HEX = "[0-9A-Fa-f]{1,4}"

    private fun interface Accept { fun accept(text: String, start: Int, end: Int): IntRange? }

    private val rules: List<Triple<PdfRedactionCategory, Regex, Accept>> by lazy {
        listOf(
            Triple(PdfRedactionCategory.IBAN, Regex("[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}"), Accept(::iban)),
            Triple(PdfRedactionCategory.EMAIL, Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), Accept(::email)),
            Triple(PdfRedactionCategory.PHONE, Regex("\\+[0-9]{1,3}(?:[ .\\-/]?\\(?[0-9]{1,4}\\)?){2,6}"), Accept(::phone)),
            Triple(PdfRedactionCategory.PHONE, Regex("\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-][0-9]{4}"), Accept(::phone)),
            Triple(PdfRedactionCategory.PHONE, Regex("0[0-9]{2,4}(?:[ /-]?[0-9]{2,8}){1,3}"), Accept(::phone)),
            Triple(PdfRedactionCategory.PAYMENT_CARD, Regex("[0-9](?:[ -]?[0-9]){12,18}"), Accept(::card)),
            Triple(PdfRedactionCategory.DATE, Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\\.[0-9]{1,2}\\.(?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}"), Accept(::date)),
            Triple(PdfRedactionCategory.DATE, Regex("[0-9]{1,2}\\.? (?:$MONTH)\\.? [0-9]{4}|(?:$MONTH)\\.? [0-9]{1,2},? [0-9]{4}"), Accept(::date)),
            Triple(PdfRedactionCategory.URL, Regex("https?://[^\\s<>\"]+|www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?:/[^\\s<>\"]*)?"), Accept(::url)),
            Triple(PdfRedactionCategory.IP_ADDRESS, Regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}"), Accept(::ip)),
            Triple(PdfRedactionCategory.IP_ADDRESS, Regex("(?:$HEX:){7}$HEX|(?:$HEX:){1,7}:(?:$HEX(?::$HEX){0,6})?|::$HEX(?::$HEX){0,6}"), Accept(::ip)),
        )
    }

    fun find(text: String, categories: Set<PdfRedactionCategory>? = null): List<PatternMatch> {
        val candidates = mutableListOf<PatternMatch>()
        for ((category, regex, accept) in rules) {
            if (categories != null && category !in categories) continue
            var from = 0
            while (from < text.length) {
                val match = regex.find(text, from) ?: break
                accept.accept(text, match.range.first, match.range.last + 1)?.let {
                    candidates += PatternMatch(category, it.first, it.last + 1)
                }
                // A rejected match may hide a valid one starting one character later.
                from = match.range.first + 1
            }
        }
        val order = { c: PdfRedactionCategory -> PdfRedactionCategory.PATTERNS.indexOf(c) }
        candidates.sortWith(compareByDescending<PatternMatch> { it.end - it.start }
            .thenBy { order(it.category) }.thenBy { it.start })
        val chosen = mutableListOf<PatternMatch>()
        for (c in candidates) if (chosen.none { c.start < it.end && it.start < c.end }) chosen += c
        return chosen.sortedBy { it.start }
    }

    private fun isWord(text: String, i: Int) = i in text.indices && text[i].isLetterOrDigit()
    private fun charAt(text: String, i: Int) = text.getOrNull(i)
    private fun continuesBefore(text: String, start: Int) =
        Regex("[0-9][ .\\-/]$").containsMatchIn(text.substring(maxOf(0, start - 2), start))
    private fun continuesAfter(text: String, end: Int) =
        Regex("^[ .\\-/][0-9]").containsMatchIn(text.substring(end, minOf(text.length, end + 2)))

    private fun mod97(iban: String): Int {
        var remainder = 0
        for (ch in iban.substring(4) + iban.substring(0, 4)) {
            val value = if (ch.isLetter()) (ch.code - 55).toString() else ch.toString()
            for (digit in value) remainder = (remainder * 10 + (digit - '0')) % 97
        }
        return remainder
    }

    private fun luhn(digits: List<Int>): Boolean = digits.reversed().mapIndexed { i, d ->
        if (i % 2 == 1) (d * 2).let { if (it > 9) it - 9 else it } else d
    }.sum() % 10 == 0

    private fun validDate(year: Int, month: Int, day: Int): Boolean {
        if (month !in 1..12 || day < 1) return false
        val leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return day <= intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
    }

    private fun iban(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1)) return null
        val positions = (start until end).filter { text[it] in 'A'..'Z' || text[it] in '0'..'9' }
        for (k in minOf(34, positions.size) downTo 15) {
            val stop = positions[k - 1] + 1
            if (isWord(text, stop)) continue
            if (mod97(positions.take(k).map { text[it] }.joinToString("")) == 1) return start until stop
        }
        return null
    }

    private fun email(text: String, start: Int, end: Int): IntRange? {
        val before = charAt(text, start - 1)
        return if (before != null && (before.isLetterOrDigit() || before in "._%+-") || isWord(text, end)) null else start until end
    }

    private fun phone(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1) || charAt(text, start - 1) == '+' || isWord(text, end)) return null
        if (continuesBefore(text, start) || continuesAfter(text, end)) return null
        return if (text.substring(start, end).count { it.isDigit() } in 7..15) start until end else null
    }

    private fun card(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1) || isWord(text, end)) return null
        if (continuesBefore(text, start) || continuesAfter(text, end)) return null
        val digits = text.substring(start, end).filter { it.isDigit() }.map { it - '0' }
        return if (digits.size in 13..19 && luhn(digits)) start until end else null
    }

    private fun date(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1) || isWord(text, end) || continuesAfter(text, end)) return null
        val s = text.substring(start, end)
        val ok = Regex("^([0-9]{4})-([0-9]{2})-([0-9]{2})$").find(s)?.destructured?.let { (y, m, d) -> validDate(y.toInt(), m.toInt(), d.toInt()) }
            ?: Regex("^([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{2}|[0-9]{4})$").find(s)?.destructured?.let { (d, m, y) ->
                validDate(if (y.length == 2) 2000 + y.toInt() else y.toInt(), m.toInt(), d.toInt()) }
            ?: Regex("^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$").find(s)?.destructured?.let { (a, b, y) ->
                validDate(y.toInt(), a.toInt(), b.toInt()) || validDate(y.toInt(), b.toInt(), a.toInt()) }
            ?: Regex("^([0-9]{1,2})\\.? ($MONTH)\\.? ([0-9]{4})$").find(s)?.destructured?.let { (d, m, y) -> validDate(y.toInt(), MONTHS.getValue(m), d.toInt()) }
            ?: Regex("^($MONTH)\\.? ([0-9]{1,2}),? ([0-9]{4})$").find(s)?.destructured?.let { (m, d, y) -> validDate(y.toInt(), MONTHS.getValue(m), d.toInt()) }
            ?: false
        return if (ok) start until end else null
    }

    private fun url(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1)) return null
        var stop = end
        while (stop > start && text[stop - 1] in ".,;:)") stop--
        return if (stop - start >= 8) start until stop else null
    }

    private fun ip(text: String, start: Int, end: Int): IntRange? {
        val s = text.substring(start, end)
        if (':' in s) {
            if (isWord(text, start - 1) || charAt(text, start - 1) == ':' || isWord(text, end) || charAt(text, end) == ':') return null
            val groups = s.split(':').filter { it.isNotEmpty() }
            return if (groups.size <= 8 && ("::" in s || groups.size == 8)) start until end else null
        }
        if (isWord(text, start - 1) || charAt(text, start - 1) == '.' || isWord(text, end) || continuesAfter(text, end)) return null
        return if (s.split('.').all { it.toInt() <= 255 }) start until end else null
    }
}
