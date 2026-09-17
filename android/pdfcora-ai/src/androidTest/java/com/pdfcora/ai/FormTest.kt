package com.pdfcora.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.PdfDocument
import com.pdfcora.PdfFormField
import com.pdfcora.ai.forms.PdfFormValue
import com.pdfcora.ai.forms.PdfProfileKey
import com.pdfcora.formFields
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FormTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun forms() = PdfDocument.open(assets.open("forms.pdf").use { it.readBytes() })
    private val profile = mapOf(
        PdfProfileKey.GIVEN_NAME to "Anna", PdfProfileKey.FAMILY_NAME to "Schmidt", PdfProfileKey.FULL_NAME to "Anna Schmidt",
        PdfProfileKey.DATE_OF_BIRTH to "1985-03-14", PdfProfileKey.EMAIL to "anna.schmidt@example.com",
        PdfProfileKey.PHONE to "+44 20 7946 0958", PdfProfileKey.STREET to "221B Baker Street", PdfProfileKey.POSTAL_CODE to "NW1 6XE",
        PdfProfileKey.CITY to "London", PdfProfileKey.COUNTRY to "United Kingdom", PdfProfileKey.IBAN to "GB29 NWBK 6016 1331 9268 19",
        PdfProfileKey.COMPANY to "Example Holdings Ltd",
    )
    private suspend fun field(document: PdfDocument, page: Int, name: String) = document.page(page).formFields().first { it.base.name == name }

    @Test fun theSynonymListProposesExactlyTheExpectedValues() = runBlocking {
        val expected = JSONArray(assets.open("forms-expected.json").use { it.readBytes().decodeToString() }).let { a ->
            (0 until a.length()).map { a.getJSONObject(it) }
        }
        val proposals = PdfAI(forms()).forms.propose(profile)
        assertFalse(proposals.modelUsed)
        assertTrue(proposals.notice.contains("Check every value before filling in the form."))
        assertEquals(expected.size, proposals.items.size)
        proposals.items.zip(expected).forEach { (p, e) ->
            assertEquals(e.getInt("pageIndex"), p.pageIndex)
            assertEquals(e.getString("fieldName"), p.fieldName)
            assertEquals(e.getString("key"), p.key.id)
            val value = e.get("value")
            assertEquals(if (value is Int) PdfFormValue.Option(value) else PdfFormValue.Text(value as String), p.value)
            assertEquals(PdfAiSource.RULES, p.source)
            assertEquals("${p.pageIndex}:${p.annotationIndex}:${p.key.id}", p.id)
        }
    }

    @Test fun aModelFillsWhatSynonymsCannotButCannotOverrideOrInvent() = runBlocking {
        val provider = PdfAiProvider { request ->
            fun id(name: String) = request.prompt.lines().first { it.contains("name \"$name\"") }.removePrefix("- id ").substringBefore(": name")
            assertFalse(request.prompt.contains("name \"fname\""))
            PdfAiResponse("", JSONObject().put("fields", JSONArray()
                .put(JSONObject().put("id", id("Colour")).put("key", "company"))
                .put(JSONObject().put("id", id("Newsletter")).put("key", "bogus"))
                .put(JSONObject().put("id", "0:0").put("key", "familyName"))).toString())
        }
        val proposals = PdfAI(forms(), PdfAIOptions(provider)).forms.propose(profile, 0..0)
        assertTrue(proposals.modelUsed)
        val byName = proposals.items.associateBy { it.fieldName }
        assertEquals(PdfProfileKey.COMPANY, byName["Colour"]?.key)
        assertEquals(PdfAiSource.CUSTOM_PROVIDER, byName["Colour"]?.source)
        assertEquals(PdfProfileKey.GIVEN_NAME, byName["fname"]?.key)
        assertNull(byName["Newsletter"])
    }

    @Test fun applyWritesOnlyAcceptedValuesAndUndoRestores() = runBlocking {
        val document = forms()
        val proposals = PdfAI(document).forms.propose(profile, 0..0)
        val applied = proposals.apply(proposals.items.filter { it.fieldName == "fname" || it.fieldName == "Country" }.map { it.id })
        assertEquals("Anna", (field(document, 0, "fname") as PdfFormField.Text).value)
        assertEquals("", (field(document, 0, "Surname_1") as PdfFormField.Text).value)
        assertEquals(listOf(1), (field(document, 0, "Country") as PdfFormField.ComboBox).selectedIndices)
        assertEquals("", (field(applied.undo(), 0, "fname") as PdfFormField.Text).value)
    }

    @Test fun anUnknownIdWritesNothing() = runBlocking {
        val document = forms()
        val proposals = PdfAI(document).forms.propose(profile)
        assertThrows(UnknownProposalException::class.java) { runBlocking { proposals.apply(listOf(proposals.items[0].id, "nope")) } }
        assertEquals("", (field(document, 0, "fname") as PdfFormField.Text).value)
    }
}
