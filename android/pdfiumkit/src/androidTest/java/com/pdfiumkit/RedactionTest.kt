package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Mirrors `web/test/redact-*.test.ts` and the iOS RedactionTests.
 *
 * The gate throughout is a raw-byte scan of the saved file, not text extraction. A black
 * box drawn over text looks right and leaves every word in the document, which is the
 * classic redaction failure and the reason this feature exists.
 */
@RunWith(AndroidJUnit4::class)
class RedactionTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().context
    private fun corpus(name: String) = context.assets.open("corpus/$name").use { it.readBytes() }
    private fun latin1(bytes: ByteArray) = bytes.toString(Charsets.ISO_8859_1)

    // MARK: - Page objects

    @Test
    fun listsTheObjectsOnAPageWithTheirBounds() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val objects = document.pageObjects(0)
            assertEquals(2, objects.size)
            assertTrue(objects.all { it.kind == PdfPageObjectKind.TEXT })
            assertEquals(20.2f, objects[0].bounds.left, 0.5f)
            assertEquals("Hello, world!", objects[0].text)
            assertEquals("Goodbye, world!", objects[1].text)
            assertEquals(16f, objects[1].fontSize!!, 0.01f)
        }
    }

    @Test
    fun pathsAreReportedAsPathsWithNoText() = runTest {
        PdfDocument.open(corpus("rectangles.pdf")).use { document ->
            val objects = document.pageObjects(0)
            assertEquals(8, objects.size)
            assertTrue(objects.all { it.kind == PdfPageObjectKind.PATH && it.text == null })
        }
    }

    @Test
    fun boundsAreNormalised() = runTest {
        for (file in listOf("hello_world.pdf", "rectangles.pdf", "annotation_stamp_with_ap.pdf")) {
            PdfDocument.open(corpus(file)).use { document ->
                for (object_ in document.pageObjects(0)) {
                    assertTrue(file, object_.bounds.left <= object_.bounds.right)
                    assertTrue(file, object_.bounds.bottom <= object_.bounds.top)
                }
            }
        }
    }

    // MARK: - Region redaction

    /** The only assertion that matters. */
    @Test
    fun redactedTextIsGoneFromTheTextAndTheBytes() = runTest {
        val saved: ByteArray
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val goodbye = document.pageObjects(0).first { it.text?.contains("Goodbye") == true }
            document.redact(listOf(PdfRedactionTarget.Region(goodbye.bounds, 0)))
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        PdfDocument.open(saved).use { reopened ->
            val text = reopened.page(0).text.string()
            assertFalse("still extractable: $text", text.contains("Goodbye"))
            assertFalse("still in the file bytes", latin1(saved).contains("Goodbye"))
            assertTrue("unrelated content was lost: $text", text.contains("Hello"))
        }
    }

    @Test
    fun anObjectOutsideTheRegionIsUntouched() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val report = document.redact(
                listOf(PdfRedactionTarget.Region(PdfRect(0f, 0f, 5f, 5f), 0)),
            )
            assertEquals(0, report.textObjects)

            val saved = document.toByteArray(PdfSaveMode.FULL)
            PdfDocument.open(saved).use {
                val text = it.page(0).text.string()
                assertTrue(text.contains("Hello") && text.contains("Goodbye"))
            }
        }
    }

    /**
     * GenerateContent rewrites the whole content stream, so anything PDFium does not
     * model as a page object is lost in the rewrite. This is the control for that.
     */
    @Test
    fun aNoOpRedactionPreservesEveryPageOfText() = runTest {
        val files = listOf(
            "hello_world.pdf", "text_form.pdf", "rectangles.pdf", "text_font.pdf",
            "hebrew_mirrored.pdf", "tagged_actual_text.pdf",
            "annotation_highlight_long_content.pdf", "find_text_consecutive.pdf",
        )
        for (file in files) {
            val before = PdfDocument.open(corpus(file)).use { it.page(0).text.string() }

            val saved = PdfDocument.open(corpus(file)).use { document ->
                document.redact(
                    listOf(PdfRedactionTarget.Region(PdfRect(-9999f, -9999f, -9998f, -9998f), 0)),
                )
                document.toByteArray(PdfSaveMode.FULL)
            }
            val after = PdfDocument.open(saved).use { it.page(0).text.string() }
            assertEquals("$file: the content stream rewrite lost text", before, after)
        }
    }

    @Test(expected = PdfError.PageOutOfRange::class)
    fun aPageThatDoesNotExistIsRefused() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            document.redact(listOf(PdfRedactionTarget.Region(PdfRect(0f, 0f, 1f, 1f), 9)))
        }
    }

    // MARK: - Splitting

    @Test
    fun aRegionOverPartOfARunRemovesOnlyThoseCharacters() = runTest {
        val saved: ByteArray
        val report: PdfRedactionReport
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val run = document.pageObjects(0).first { it.text == "Goodbye, world!" }
            val region = PdfRect(run.bounds.left, run.bounds.bottom, run.bounds.left + 62f, run.bounds.top)
            report = document.redact(listOf(PdfRedactionTarget.Region(region, 0)))
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        PdfDocument.open(saved).use {
            val text = it.page(0).text.string()
            assertFalse("covered word survived: $text", text.contains("Goodbye"))
            assertTrue("uncovered text was lost: $text", text.contains("world"))
        }
        assertFalse(latin1(saved).contains("Goodbye"))
        assertEquals(1, report.textObjectsSplit)
        assertEquals("the run was split, not removed outright", 0, report.textObjects)
    }

    /** A character half inside the region is still legible, so it goes. */
    @Test
    fun charactersAreDroppedOnIntersectionNotContainment() = runTest {
        val saved: ByteArray
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val run = document.pageObjects(0).first { it.text == "Goodbye, world!" }
            val region = PdfRect(run.bounds.left, run.bounds.bottom, run.bounds.left + 4f, run.bounds.top)
            document.redact(listOf(PdfRedactionTarget.Region(region, 0)))
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        PdfDocument.open(saved).use {
            val text = it.page(0).text.string()
            assertFalse(text.contains("Goodbye"))
            assertTrue("the rest of the word should remain: $text", text.contains("oodbye"))
        }
    }

    @Test
    fun theSurvivingTextKeepsItsFontSize() = runTest {
        val saved: ByteArray
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val run = document.pageObjects(0).first { it.text == "Goodbye, world!" }
            document.redact(
                listOf(
                    PdfRedactionTarget.Region(
                        PdfRect(run.bounds.left, run.bounds.bottom, run.bounds.left + 62f, run.bounds.top),
                        0,
                    ),
                ),
            )
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        PdfDocument.open(saved).use { document ->
            val survivor = document.pageObjects(0).first {
                it.text?.contains("world") == true && it.text?.contains("Hello") == false
            }
            assertEquals(
                "a split that loses the size reflows the page",
                16f, survivor.fontSize!!, 0.01f,
            )
        }
    }

    // MARK: - Search

    @Test
    fun redactingBySearchRemovesEveryOccurrence() = runTest {
        val saved: ByteArray
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            document.redact(listOf(PdfRedactionTarget.TextMatches("world")))
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        PdfDocument.open(saved).use {
            val text = it.page(0).text.string()
            assertFalse("still present: $text", text.contains("world"))
        }
        assertFalse("still in the file bytes", latin1(saved).contains("world"))
    }

    @Test
    fun aQueryThatMatchesNothingChangesNothing() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val report = document.redact(listOf(PdfRedactionTarget.TextMatches("zzzzz")))
            assertEquals(0, report.textObjects + report.textObjectsSplit)
        }
    }

    // MARK: - Scrub

    @Test
    fun anAnnotationOverTheRegionIsRemoved() = runTest {
        PdfDocument.open(corpus("annotation_highlight_long_content.pdf")).use { document ->
            val annotations = document.page(0).annotations()
            assertTrue(annotations.isNotEmpty())

            val report = document.redact(
                listOf(PdfRedactionTarget.Region(annotations[0].base.rect, 0)),
            )
            assertTrue("the report must say the annotation went", report.annotations > 0)

            val saved = document.toByteArray(PdfSaveMode.FULL)
            PdfDocument.open(saved).use {
                assertTrue(it.page(0).annotations().size < annotations.size)
            }
        }
    }

    /** A filled field carries its value outside the content stream, in the AcroForm. */
    @Test
    fun aFormFieldValueInTheRegionIsRemoved() = runTest {
        val saved: ByteArray
        PdfDocument.open(corpus("text_form.pdf")).use { document ->
            val page = document.page(0)
            val field = page.formFields().first()
            page.setText("SECRETVALUE", field.base.annotationIndex)

            val report = document.redact(listOf(PdfRedactionTarget.Region(field.base.rect, 0)))
            assertTrue("the widget is an annotation and must go", report.annotations > 0)
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        assertFalse(
            "a filled field carries the text out of the document",
            latin1(saved).contains("SECRETVALUE"),
        )
    }
}

/**
 * The redaction contract, asserted identically on all three platforms.
 *
 * The gate is the saved bytes, not the text layer: a black box over text passes an
 * extraction check and leaves every word in the file.
 */
@RunWith(AndroidJUnit4::class)
class RedactionContractTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().context

    @Test
    fun redactedContentIsGoneFromTheTextAndTheBytes() = runTest {
        val base = context.assets.open("corpus/hello_world.pdf").use { it.readBytes() }
        val saved: ByteArray
        val report: PdfRedactionReport

        PdfDocument.open(base).use { document ->
            val goodbye = document.pageObjects(0).first { it.text?.contains("Goodbye") == true }
            report = document.redact(listOf(PdfRedactionTarget.Region(goodbye.bounds, 0)))
            saved = document.toByteArray(PdfSaveMode.FULL)
        }

        assertEquals(1, report.textObjects)
        assertEquals(listOf(0), report.pages)

        PdfDocument.open(saved).use {
            val text = it.page(0).text.string()
            assertFalse("still extractable: $text", text.contains("Goodbye"))
            assertTrue("unrelated content must survive", text.contains("Hello"))
        }
        assertFalse(
            "still in the file bytes",
            saved.toString(Charsets.ISO_8859_1).contains("Goodbye"),
        )
    }
}
