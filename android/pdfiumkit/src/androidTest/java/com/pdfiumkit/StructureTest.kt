package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.cms.PdfSignatureValidity
import com.pdfiumkit.license.PdfLicense
import com.pdfiumkit.writer.PdfDictionaryReader
import com.pdfiumkit.writer.PdfValue
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Mirrors `web/test/structure.test.ts` and `ios/Tests/PdfiumKitTests/StructureTests.swift`. */
@RunWith(AndroidJUnit4::class)
class StructureTest {
    @After fun restore() = LicenseFixture.installFullKey()

    private fun asset(path: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }
    private fun tagged() = asset("alt-text/tagged.pdf")

    private val edits = listOf(
        PdfFigureEdit.AltText(0, listOf(4), "A photo of an office building at dusk"),
        PdfFigureEdit.Decorative(0, listOf(6)),
        PdfFigureEdit.AltText(1, listOf(2), "Company logo: a red circle (é)"),
    )

    private fun flatten(elements: List<PdfStructureElement>): List<PdfStructureElement> =
        elements.flatMap { listOf(it) + flatten(it.children) }

    private suspend fun figures(document: PdfDocument, page: Int) =
        flatten(document.page(page).structure()).filter { it.type == "Figure" }

    @Test fun readsTheTaggedTestDocument() = runBlocking {
        val document = PdfDocument.open(tagged())
        assertTrue(document.isTagged())
        val roots = document.page(0).structure()
        assertEquals(listOf("Document"), roots.map { it.type })
        assertEquals(listOf("H1", "P", "Figure", "P", "Figure", "P", "Figure", "P"), roots[0].children.map { it.type })
        assertEquals((0..7).map { listOf(it) }, roots[0].children.map { it.markedContentIds })

        val page0 = figures(document, 0)
        assertEquals("Bar chart of revenue by region", page0[0].altText)
        assertNull(page0[1].altText)
        assertEquals(PdfRect(72f, 300f, 288f, 444f), page0[1].bounds)
        assertEquals(2f, page0[2].bounds!!.top - page0[2].bounds!!.bottom, 0.01f)
        assertEquals(listOf(2), figures(document, 1)[0].markedContentIds)
    }

    @Test fun anUntaggedDocumentHasNoStructure() = runBlocking {
        val document = PdfDocument.open(asset("corpus/hello_world.pdf"))
        assertFalse(document.isTagged())
        assertEquals(emptyList<PdfStructureElement>(), document.page(0).structure())
    }

    @Test fun writesDescriptionsAndDecorativeIntoANewDocument() = runBlocking {
        val document = PdfDocument.open(tagged())
        val updated = document.updateFigures(edits)
        assertEquals(listOf("Bar chart of revenue by region", "A photo of an office building at dusk"), figures(updated, 0).map { it.altText })
        assertEquals(listOf("Company logo: a red circle (é)"), figures(updated, 1).map { it.altText })
        assertEquals("the original keeps every figure", 3, figures(document, 0).size)

        // Pulled by scripts/test-android.sh for the PDF/UA check.
        File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "pdfiumkit-android-alt-text.pdf")
            .writeBytes(updated.toByteArray())
    }

    @Test fun descriptionOnlyEditsAreAnIncrementalUpdate() = runBlocking {
        val original = tagged()
        val bytes = PdfDocument.open(original).updateFigures(listOf(edits[0])).toByteArray(PdfSaveMode.INCREMENTAL)
        assertArrayEquals(original, bytes.copyOfRange(0, original.size))
    }

    @Test fun aFigureInAnObjectStreamOfASignedFileIsRewrittenAndStillVerifies() = runBlocking {
        val updated = PdfDocument.open(asset("corpus/signed_unh_iol.pdf"))
            .updateFigures(listOf(PdfFigureEdit.AltText(0, listOf(27), "UNH-IOL logo")))
        assertEquals("UNH-IOL logo", figures(updated, 0).first().altText)
        val verdict = updated.verify(updated.signatures().first())
        assertTrue("expected Untrusted, got $verdict", verdict is PdfSignatureValidity.Untrusted)
    }

    @Test fun anEditNamingNoFigureWritesNothing() = runBlocking {
        val document = PdfDocument.open(tagged())
        for (wrong in listOf(PdfFigureEdit.AltText(0, listOf(99), "x"), PdfFigureEdit.AltText(0, listOf(1), "x"))) {
            try {
                document.updateFigures(listOf(edits[0], wrong))
                fail("expected InvalidOperation")
            } catch (e: PdfError.InvalidOperation) {
            }
        }
        try {
            document.updateFigures(listOf(PdfFigureEdit.AltText(5, listOf(4), "x")))
            fail("expected PageOutOfRange")
        } catch (e: PdfError.PageOutOfRange) {
        }
    }

    @Test fun stringsInARewrittenElementSurvive() {
        val source = "<</T (a \\(b\\) c\\\\ é) /Lang <FEFF0064>>>"
        val value = PdfDictionaryReader(source).read(0)
        assertEquals("<</T (a \\(b\\) c\\\\ é)>>",
            PdfValue.serialize(PdfValue.Dictionary(listOf("T" to value.getValue("T")))).toString(Charsets.ISO_8859_1))
        assertEquals("<FEFF0064>", PdfValue.serialize(value.getValue("Lang")).toString(Charsets.ISO_8859_1))
    }

    @Test fun aTrialDocumentWritesAWatermarkedResult() = runBlocking {
        PdfLicense.configureForTesting(key = null, setKey = true)
        val updated = PdfDocument.open(tagged()).updateFigures(listOf(edits[0]))
        assertTrue(updated.needsWatermark)
        val text = PdfDocument.open(updated.toByteArray()).page(0).text.string()
        assertEquals(1, text.split("PdfiumKit trial").size - 1)
    }
}
