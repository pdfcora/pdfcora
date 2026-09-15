package com.pdfiumkit.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.PdfDocument
import com.pdfiumkit.ai.forms.PdfProfileKey
import com.pdfiumkit.formFields
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web-ai/test/forms-detect.test.ts` and `ios/Tests/PdfiumKitAITests/FormDetectTests.swift`. */
@RunWith(AndroidJUnit4::class)
class FormDetectTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun flat() = PdfDocument.open(assets.open("flat.pdf").use { it.readBytes() })

    @Test fun theRulesFindTheExpectedBlanks() = runBlocking {
        val expected = JSONArray(assets.open("flat-expected.json").use { it.readBytes().decodeToString() })
        val detected = PdfiumAI(flat()).forms.detect()
        assertTrue(detected.notice.contains("Check every field before it is added."))
        assertEquals(expected.length(), detected.items.size)
        detected.items.forEachIndexed { n, item ->
            val e = expected.getJSONObject(n)
            assertEquals("0:$n", item.id)
            assertEquals(e.getString("kind"), if (item.kind.name == "TEXT") "text" else "checkBox")
            assertEquals(e.getString("label"), item.label)
            val r = e.getJSONObject("rect")
            listOf(item.rect.left to r.getDouble("left"), item.rect.bottom to r.getDouble("bottom"),
                item.rect.right to r.getDouble("right"), item.rect.top to r.getDouble("top"))
                .forEach { (a, b) -> assertEquals(item.label, b, a.toDouble(), 1.0) }
        }
    }

    @Test fun acceptedFieldsAreCreatedAndFormFillingUsesThem() = runBlocking {
        val detected = PdfiumAI(flat()).forms.detect()
        val withFields = detected.apply(detected.items.map { it.id })
        assertEquals(detected.items.map { it.label }, withFields.page(0).formFields().map { it.base.name })
        val proposals = PdfiumAI(withFields).forms.propose(mapOf(PdfProfileKey.GIVEN_NAME to "Anna",
            PdfProfileKey.FAMILY_NAME to "Schmidt", PdfProfileKey.EMAIL to "anna@example.com", PdfProfileKey.CITY to "London"))
        assertEquals(listOf("First name", "Last name", "Email", "City"), proposals.items.map { it.fieldName })
        assertEquals(emptyList<Any>(), PdfiumAI(withFields).forms.detect().items)
        try { detected.apply(listOf("9:9")); fail() } catch (e: UnknownProposalException) {}
    }
}
