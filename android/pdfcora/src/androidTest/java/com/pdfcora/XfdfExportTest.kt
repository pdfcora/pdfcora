package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.xfdf.XfdfXml
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web/test/xfdf-export.test.ts` and `ios/Tests/PDFCoraTests/XfdfExportTests.swift`. */
@RunWith(AndroidJUnit4::class)
class XfdfExportTest {
    private fun asset(path: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }

    @Test fun exportsConformanceDocumentExactly() = runBlocking {
        val document = PdfDocument.open(asset("xfdf/source.pdf"))
        assertEquals(asset("xfdf/expected-export.xfdf").decodeToString(), document.exportXfdf())
    }

    @Test fun markupAnnotationsReportTheirQuads() = runBlocking {
        val highlight = PdfDocument.open(asset("xfdf/source.pdf")).page(0).annotations()
            .filterIsInstance<PdfAnnotation.Highlight>().first()
        assertEquals(listOf(PdfQuad(PdfPoint(72f, 714f), PdfPoint(200f, 714f), PdfPoint(72f, 700f), PdfPoint(200f, 700f))),
            highlight.quads)
    }

    @Test fun exportEscapesAndKeepsUnicode() = runBlocking {
        val xfdf = PdfDocument.open(asset("xfdf/source.pdf")).exportXfdf()
        assertTrue(xfdf.contains("<value>Zoë &amp; \"Co\" &lt;ok&gt;</value>"))
        assertTrue(xfdf.contains("title=\"Zoë &amp; &quot;Co&quot; &lt;ok&gt;\""))
        assertTrue(xfdf.contains("<contents>A note &amp; a &lt;tag&gt;</contents>"))
    }

    @Test fun exportsEmptyDocument() = runBlocking {
        val xfdf = PdfDocument.open(asset("corpus/hello_world.pdf")).exportXfdf()
        assertEquals("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">\n</xfdf>\n", xfdf)
    }

    @Test fun parserRejectsDoctypeAndUnknownEntities() {
        assertThrows(PdfError.InvalidOperation::class.java) {
            XfdfXml.parse("<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]><x>&e;</x>")
        }
        assertThrows(PdfError.InvalidOperation::class.java) { XfdfXml.parse("<x>&nbsp;</x>") }
        assertThrows(PdfError.InvalidOperation::class.java) { XfdfXml.parse("<x><y></x>") }
        val root = XfdfXml.parse("<a x=\"1&amp;2\"><b>t&lt;&#233;</b></a>")
        assertEquals("1&2", root.attributes["x"])
        assertEquals("t<é", root.children.first().text.toString())
    }
}
