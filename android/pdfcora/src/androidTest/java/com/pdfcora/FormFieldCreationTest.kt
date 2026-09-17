package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web/test/form-fields.test.ts` and `ios/Tests/PDFCoraTests/FormFieldCreationTests.swift`. */
@RunWith(AndroidJUnit4::class)
class FormFieldCreationTest {
    private fun asset(path: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }

    private val fields = listOf(
        PdfNewFormField(0, PdfNewFormField.Kind.TEXT, PdfRect(179.5f, 621.5f, 500.5f, 642.5f), "Email", "Email"),
        PdfNewFormField(0, PdfNewFormField.Kind.CHECK_BOX, PdfRect(71.5f, 517.5f, 84.5f, 530.5f), "I agree to the terms"),
    )

    @Test fun createdFieldsFillAndKeepTheirValues() = runBlocking {
        val document = PdfDocument.open(asset("forms/flat.pdf"))
        val withFields = document.addFormFields(fields)
        assertEquals(0, document.page(0).formFields().size)

        val page = withFields.page(0)
        val created = page.formFields()
        assertEquals(listOf("Email", "I agree to the terms"), created.map { it.base.name })
        assertEquals(listOf("Email", null), created.map { it.base.alternateName })
        assertEquals(fields[0].rect, created[0].base.rect)

        page.setText("anna@example.com", created[0].base.annotationIndex)
        page.setChecked(true, created[1].base.annotationIndex)
        val after = PdfDocument.open(withFields.toByteArray()).page(0).formFields()
        assertEquals("anna@example.com", (after[0] as PdfFormField.Text).value)
        assertTrue((after[1] as PdfFormField.CheckBox).isChecked)
    }

    @Test fun existingFieldsAreKeptAndNamesMustBeNew() = runBlocking {
        val document = PdfDocument.open(asset("corpus/text_form.pdf"))
        val existing = document.page(0).formFields()
        val moved = PdfNewFormField(0, PdfNewFormField.Kind.TEXT, PdfRect(300f, 50f, 500f, 70f), "Email")
        assertEquals(listOf(existing[0].base.name, "Email"), document.addFormFields(listOf(moved)).page(0).formFields().map { it.base.name })
        for (bad in listOf(listOf(moved.copy(name = existing[0].base.name!!)), listOf(moved, moved), listOf(moved.copy(name = " ")))) {
            try { document.addFormFields(bad); fail("expected InvalidOperation") } catch (e: PdfError.InvalidOperation) {}
        }
    }
}
