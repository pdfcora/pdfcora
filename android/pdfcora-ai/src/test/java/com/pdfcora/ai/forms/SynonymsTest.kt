package com.pdfcora.ai.forms

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class SynonymsTest {
    private val cases = JSONArray(File("../../conformance/forms/matching.json").readText())

    @Test fun sharedMatchingCases() {
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            fun opt(k: String) = if (c.isNull(k)) null else c.getString(k)
            assertEquals(c.toString(), c.getString("expected"),
                Synonyms.key(opt("name"), opt("alternateName"), opt("label"))?.id ?: "unknown")
        }
    }
}
