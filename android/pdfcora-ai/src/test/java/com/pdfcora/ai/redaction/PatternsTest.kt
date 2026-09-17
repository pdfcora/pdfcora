package com.pdfcora.ai.redaction

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class PatternsTest {
    // JVM unit tests run with the module directory as the working directory.
    private val cases = JSONArray(File("../../conformance/redaction/patterns.json").readText())

    @Test fun sharedCases() {
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val text = c.getString("text")
            val expected = c.getJSONArray("expected").let { a -> (0 until a.length()).map { a.getJSONArray(it).let { p -> p.getString(0) to p.getString(1) } } }
            val found = Patterns.find(text).map { it.category.id to text.substring(it.start, it.end) }
            assertEquals(text, expected, found)
        }
    }

    @Test fun categoriesRestrictWhatIsLookedFor() {
        val found = Patterns.find("anna@example.com 4111 1111 1111 1111", setOf(PdfRedactionCategory.EMAIL))
        assertEquals(listOf(PdfRedactionCategory.EMAIL), found.map { it.category })
    }
}
