package com.pdfiumkit.ai.forms

/** A profile value's meaning (FORM-2). The order is also the tie-break order. */
enum class PdfProfileKey(val id: String) {
    GIVEN_NAME("givenName"), FAMILY_NAME("familyName"), FULL_NAME("fullName"), DATE_OF_BIRTH("dateOfBirth"),
    EMAIL("email"), PHONE("phone"), STREET("street"), POSTAL_CODE("postalCode"), CITY("city"),
    COUNTRY("country"), IBAN("iban"), COMPANY("company"),
}

/**
 * Matching a form field to a profile key without a model (FORM-3), in English and German.
 * Behaviour is pinned by conformance/forms/matching.json, which every platform runs.
 */
internal object Synonyms {
    private val PHRASES = mapOf(
        PdfProfileKey.GIVEN_NAME to listOf("first name", "given name", "forename", "vorname", "rufname"),
        PdfProfileKey.FAMILY_NAME to listOf("last name", "surname", "family name", "nachname", "familienname", "zuname"),
        PdfProfileKey.FULL_NAME to listOf("full name", "name", "your name", "vollständiger name", "name und vorname"),
        PdfProfileKey.DATE_OF_BIRTH to listOf("date of birth", "birth date", "birthday", "dob", "geburtsdatum", "geboren am"),
        PdfProfileKey.EMAIL to listOf("email", "e-mail", "email address", "e-mail address", "e-mail-adresse", "mail"),
        PdfProfileKey.PHONE to listOf("phone", "telephone", "phone number", "mobile", "telefon", "telefonnummer", "mobilnummer", "handy"),
        PdfProfileKey.STREET to listOf("street", "address", "street address", "address line 1", "straße", "strasse", "straße und hausnummer", "anschrift"),
        PdfProfileKey.POSTAL_CODE to listOf("postal code", "postcode", "zip", "zip code", "plz", "postleitzahl"),
        PdfProfileKey.CITY to listOf("city", "town", "ort", "stadt", "wohnort"),
        PdfProfileKey.COUNTRY to listOf("country", "land", "staat"),
        PdfProfileKey.IBAN to listOf("iban", "bank account", "kontonummer"),
        PdfProfileKey.COMPANY to listOf("company", "organisation", "organization", "employer", "firma", "unternehmen", "arbeitgeber"),
    )
    private val HINT = Regex("""\(([^()]*)\)\s*$""")

    /** A trailing "(MM/DD/YYYY)" and the like: kept for formatting, ignored for matching. */
    fun formatHint(text: String): String? = HINT.find(text)?.groupValues?.get(1)

    fun normalise(text: String): String = text.replace(HINT, "").lowercase()
        .replace("ß", "ss").replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
        .replace(Regex("[_\\-./0-9]"), " ").replace(Regex("[^\\p{L} ]"), "")
        .replace(Regex("\\s+"), " ").trim()

    private val normalised by lazy {
        PdfProfileKey.values().flatMap { key -> PHRASES.getValue(key).map { key to normalise(it) } }
    }

    /** The key a text names, or null. Most words wins, then most letters, then key order. */
    fun key(text: String): PdfProfileKey? {
        val padded = " ${normalise(text)} "
        if (padded.isBlank()) return null
        var best: Triple<PdfProfileKey, Int, Int>? = null
        for ((key, phrase) in normalised) {
            if (!padded.contains(" $phrase ")) continue
            val words = phrase.split(' ').size
            val letters = phrase.replace(" ", "").length
            if (best == null || words > best.second || (words == best.second && letters > best.third)) best = Triple(key, words, letters)
        }
        return best?.first
    }

    /** Tooltip, then label, then name: the first that names a key decides. */
    fun key(name: String?, alternateName: String?, label: String?): PdfProfileKey? =
        listOf(alternateName, label, name).firstNotNullOfOrNull { text -> text?.let { key(it) } }
}
