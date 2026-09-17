package com.pdfcora.ai.diff

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class DiffAlignerTest {
    @Test fun similarityCases() {
        val cases = JSONArray(File("../../conformance/diff/similarity.json").readText())
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val value = DiffAligner.similarity(c.getString("a"), c.getString("b"))
            if (c.has("atLeast")) assertTrue("$c: $value", value >= c.getDouble("atLeast"))
            if (c.has("below")) assertTrue("$c: $value", value < c.getDouble("below"))
            if (c.has("exactly")) assertEquals(c.toString(), c.getDouble("exactly"), value, 0.0)
        }
    }

    @Test fun parsesOnlyTheTwoLabels() {
        assertEquals(PdfDiffLabel.WORDING_ONLY, DiffAligner.parse("""{"label":"wordingOnly","summary":""}""")?.label)
        assertNull(DiffAligner.parse("""{"label":"maybe"}"""))
    }
}
