package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FeatureTest {

    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private fun corpus(name: String) = assets.open("corpus/$name").use { it.readBytes() }
    private suspend fun open(name: String) = PdfDocument.open(corpus(name))

    // MARK: - Text

    @Test
    fun extractsText() = runTest {
        open("hello_world.pdf").use { document ->
            val text = document.page(0).text.string()
            assertTrue("expected 'Hello' in: $text", text.contains("Hello"))
        }
    }

    @Test
    fun characterCountIsPositive() = runTest {
        open("hello_world.pdf").use { document ->
            assertTrue(document.page(0).text.characterCount() > 0)
        }
    }

    @Test
    fun searchFindsKnownTerm() = runTest {
        open("hello_world.pdf").use { document ->
            val matches = document.page(0).text.search("Hello")
            assertTrue("search found nothing", matches.isNotEmpty())
            assertTrue("match has no rects", matches[0].rects.isNotEmpty())
        }
    }

    @Test
    fun searchForAbsentTermReturnsNothing() = runTest {
        open("hello_world.pdf").use { document ->
            assertTrue(document.page(0).text.search("zzzznotpresentzzzz").isEmpty())
        }
    }

    // MARK: - Form fields

    @Test
    fun comboBoxIsDiscoveredWithOptions() = runTest {
        open("combobox_form.pdf").use { document ->
            val fields = document.page(0).formFields()
            assertTrue("no form fields found", fields.isNotEmpty())
            val combo = fields.filterIsInstance<PdfFormField.ComboBox>().firstOrNull()
            assertTrue("expected a combo box, got ${fields.map { it::class.simpleName }}", combo != null)
            assertTrue("combo box has no options", combo!!.options.isNotEmpty())
        }
    }

    @Test
    fun textFieldRoundTripsAValue() = runTest {
        open("text_form.pdf").use { document ->
            val page = document.page(0)
            val target = page.formFields().filterIsInstance<PdfFormField.Text>().first()
            page.setText("John Doe", fieldAt = target.base.annotationIndex)

            val updated = page.formFields()
                .first { it.base.annotationIndex == target.base.annotationIndex }
            assertTrue(updated is PdfFormField.Text)
            assertEquals("John Doe", (updated as PdfFormField.Text).value)
        }
    }

    @Test
    fun checkboxStateCanBeSet() = runTest {
        open("click_form.pdf").use { document ->
            val page = document.page(0)
            val target = page.formFields().filterIsInstance<PdfFormField.CheckBox>().first()
            val before = target.isChecked

            page.setChecked(!before, fieldAt = target.base.annotationIndex)

            val updated = page.formFields()
                .filterIsInstance<PdfFormField.CheckBox>()
                .first { it.base.annotationIndex == target.base.annotationIndex }
            assertNotEquals("checkbox state did not change", before, updated.isChecked)
        }
    }

    // MARK: - Annotations

    @Test
    fun existingAnnotationsAreRead() = runTest {
        open("annotation_highlight_long_content.pdf").use { document ->
            val annotations = document.page(0).annotations()
            assertTrue("expected annotations", annotations.isNotEmpty())
            assertTrue(
                "expected a highlight, got ${annotations.map { it::class.simpleName }}",
                annotations.any { it is PdfAnnotation.Highlight }
            )
        }
    }

    @Test
    fun addedInkIsReadBack() = runTest {
        open("hello_world.pdf").use { document ->
            val page = document.page(0)
            val before = page.annotations().size

            page.addInk(listOf(PdfPoint(10f, 10f), PdfPoint(50f, 50f), PdfPoint(90f, 20f)))

            val after = page.annotations()
            assertEquals(before + 1, after.size)
            val ink = after.last()
            assertTrue("last annotation is not ink: $ink", ink is PdfAnnotation.Ink)
            assertEquals(1, (ink as PdfAnnotation.Ink).strokes.size)
            assertEquals(3, ink.strokes[0].size)
        }
    }

    @Test
    fun addedNoteCarriesItsContents() = runTest {
        open("hello_world.pdf").use { document ->
            val page = document.page(0)
            page.addNote(PdfRect(10f, 10f, 40f, 40f), "a review comment")
            assertEquals("a review comment", page.annotations().last().base.contents)
        }
    }

    @Test
    fun annotationCanBeRemoved() = runTest {
        open("hello_world.pdf").use { document ->
            val page = document.page(0)
            page.addNote(PdfRect(1f, 1f, 2f, 2f), "x")
            val added = page.annotations().size
            page.removeAnnotation(added - 1)
            assertEquals(added - 1, page.annotations().size)
        }
    }

    // MARK: - Save round-trip

    @Test
    fun editsSurviveSaveAndReopen() = runTest {
        val saved = open("hello_world.pdf").use { document ->
            document.page(0).addNote(PdfRect(10f, 10f, 40f, 40f), "persisted note")
            document.toByteArray()
        }
        assertTrue(saved.isNotEmpty())

        PdfDocument.open(saved).use { reopened ->
            val annotations = reopened.page(0).annotations()
            assertTrue(
                "the note did not survive save/reopen",
                annotations.any { it.base.contents == "persisted note" }
            )
        }
    }

    @Test
    fun formValueSurvivesSaveAndReopen() = runTest {
        var annotationIndex = -1
        val saved = open("text_form.pdf").use { document ->
            val page = document.page(0)
            val target = page.formFields().filterIsInstance<PdfFormField.Text>().first()
            annotationIndex = target.base.annotationIndex
            page.setText("Persisted", fieldAt = annotationIndex)
            document.toByteArray()
        }

        PdfDocument.open(saved).use { reopened ->
            val field = reopened.page(0).formFields()
                .filterIsInstance<PdfFormField.Text>()
                .first { it.base.annotationIndex == annotationIndex }
            assertEquals("Persisted", field.value)
        }
    }

    /**
     * The web build once lost every edit here: form state outlived close() and was
     * inherited by the next document to reuse the handle.
     */
    @Test
    fun formValueSurvivesSaveWhenEarlierFormDocumentsWereClosed() = runTest {
        repeat(10) { cycle ->
            open(if (cycle % 2 == 0) "click_form.pdf" else "combobox_form.pdf").use {
                it.page(0).formFields()
            }

            open("text_form.pdf").use { document ->
                val page = document.page(0)
                val index = page.formFields().filterIsInstance<PdfFormField.Text>().first().base.annotationIndex
                page.setText("value $cycle", fieldAt = index)

                PdfDocument.open(document.toByteArray()).use { reopened ->
                    val field = reopened.page(0).formFields()
                        .filterIsInstance<PdfFormField.Text>()
                        .first { it.base.annotationIndex == index }
                    assertEquals("cycle $cycle", "value $cycle", field.value)
                }
            }
        }
    }

    @Test
    fun linksAreResolved() = runTest {
        open("annots_action_handling.pdf").use { document ->
            val links = document.page(0).links()
            assertTrue("expected links", links.isNotEmpty())
            assertTrue("expected a URI target",
                links.any { it.target is PdfLink.Target.Uri })
            assertTrue("expected an internal page target",
                links.any { it.target is PdfLink.Target.Page })
        }
    }

    @Test
    fun characterBoxIsReadable() = runTest {
        open("hello_world.pdf").use { document ->
            val box = document.page(0).text.boundingBox(0)
            assertTrue("expected a positive-width box: $box", box.right > box.left)
            assertTrue("expected a positive-height box: $box", box.top > box.bottom)
        }
    }

    @Test
    fun embeddedAttachmentsAreListedAndExtracted() = runTest {
        open("embedded_attachments.pdf").use { document ->
            val list = document.attachments()
            assertEquals(listOf("1.txt", "attached.pdf"), list.map { it.name })
            assertEquals("test", String(document.attachmentData(0)))

            val nested = document.attachmentData(1)
            assertTrue("implausible size ${nested.size}", nested.size in 1001..99_999)
            assertEquals("%PDF-", String(nested.copyOfRange(0, 5)))
        }
    }

    /**
     * The `forms` option was declared and ignored once: the JNI called FPDF_FFLDraw
     * unconditionally, so a caller could not omit the value layer. Matches iOS and Web,
     * where `.forms` paints the value and its absence does not.
     */
    @Test
    fun formsFlagControlsWhetherTheValueIsPainted() = runTest {
        open("text_form.pdf").use { document ->
            val page = document.page(0)
            val field = page.formFields().filterIsInstance<PdfFormField.Text>().first()
            page.setText("WIDGETVALUE", fieldAt = field.base.annotationIndex)

            val size = page.size()
            suspend fun inkInField(forms: Boolean): Int {
                val bmp = page.render(width = 600, options = PdfRenderOptions(forms = forms))
                val s = 600f / size.width
                val r = field.base.rect
                var n = 0
                for (y in ((size.height - r.top) * s).toInt() until ((size.height - r.bottom) * s).toInt())
                    for (x in (r.left * s).toInt() until (r.right * s).toInt()) {
                        if (y in 0 until bmp.height && x in 0 until bmp.width) {
                            val c = bmp.getPixel(x, y)
                            if (android.graphics.Color.red(c) < 200 ||
                                android.graphics.Color.green(c) < 200 ||
                                android.graphics.Color.blue(c) < 200) n++
                        }
                    }
                return n
            }

            assertTrue("forms = true should paint the value", inkInField(true) > 0)
            assertEquals("forms = false must not paint the value", 0, inkInField(false))
        }
    }

    @Test
    fun outlineIsReadable() = runTest {
        open("annots_action_handling.pdf").use { document ->
            document.outline()   // may legitimately be empty; the contract is that it succeeds
        }
    }

    // MARK: - Metadata and lifetime

    @Test
    fun metadataReadsWithoutThrowing() = runTest {
        open("hello_world.pdf").use { document ->
            document.metadata()   // corpus files may carry none; the contract is that it succeeds
        }
    }

    @Test
    fun usingAClosedDocumentThrowsClosedNotACrash() = runTest {
        val document = open("hello_world.pdf")
        document.close()
        try {
            document.pageCount()
            fail("expected PdfError.Closed")
        } catch (e: PdfError) {
            assertTrue("got $e", e is PdfError.Closed)
        }
    }

    @Test
    fun pageOutOfRangeReportsTheBounds() = runTest {
        open("hello_world.pdf").use { document ->
            try {
                document.page(99)
                fail("expected PageOutOfRange")
            } catch (e: PdfError.PageOutOfRange) {
                assertEquals(99, e.index)
                assertEquals(1, e.count)
            }
        }
    }

    @Test
    fun wrongPasswordIsDistinguishedFromMissingPassword() = runTest {
        val bytes = corpus("encrypted_hello_world_r2.pdf")
        try {
            PdfDocument.open(bytes).close()
            fail("expected PasswordRequired")
        } catch (e: PdfError) {
            assertTrue("got $e", e is PdfError.PasswordRequired)
        }
        try {
            PdfDocument.open(bytes, "definitely-not-it").close()
            fail("expected WrongPassword")
        } catch (e: PdfError) {
            assertTrue("got $e", e is PdfError.WrongPassword)
        }
    }

    /**
     * PDFium's last error is one global. Reading it in a separate hop from the failed
     * load let another document's failure overwrite it in between.
     */
    @Test
    fun concurrentFailedOpensEachReportTheirOwnError() = runTest {
        val encrypted = corpus("encrypted_hello_world_r2.pdf")
        val garbage = "not a pdf at all".toByteArray()
        val errors = withContext(Dispatchers.Default) {
            (0 until 200).map { i ->
                async {
                    val expectPassword = i % 2 == 0
                    try {
                        PdfDocument.open(if (expectPassword) encrypted else garbage).close()
                        "opened"
                    } catch (e: PdfError) {
                        val right = if (expectPassword) e is PdfError.PasswordRequired else e is PdfError.Corrupt
                        if (right) null else "$i: $e"
                    }
                }
            }.awaitAll().filterNotNull()
        }
        assertTrue("mismatched errors: ${errors.take(5)}", errors.isEmpty())
    }

    // MARK: - Concurrency

    /**
     * The core safety claim: hammering one document from many coroutines must not
     * corrupt memory, because every call is funnelled onto the document's dispatcher.
     */
    @Test
    fun concurrentAccessToOneDocumentIsSafe() = runTest {
        open("many_rectangles.pdf").use { document ->
            coroutineScope {
                val results = (0 until 32).map {
                    async {
                        val page = document.page(0)
                        val bitmap = page.render(width = 64)
                        val text = page.text.string()
                        bitmap.width + text.length
                    }
                }.awaitAll()
                assertEquals(32, results.size)
            }
        }
    }

    @Test
    fun separateDocumentsRenderConcurrently() = runTest {
        coroutineScope {
            listOf("hello_world.pdf", "rectangles.pdf", "many_rectangles.pdf", "text_font.pdf")
                .map { name ->
                    async { open(name).use { it.page(0).render(width = 120).width } }
                }
                .awaitAll()
                .forEach { assertEquals(120, it) }
        }
    }
}
