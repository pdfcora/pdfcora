package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.writer.PdfValue
import com.pdfiumkit.writer.PdfWriter
import com.pdfiumkit.writer.TrailerInfo
import com.pdfiumkit.writer.XrefStyle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Mirrors `web/test/writer-*.test.ts` and `ios/Tests/PdfiumKitTests/WriterTests.swift`
 * assertion for assertion, so all three implementations meet one contract.
 */
@RunWith(AndroidJUnit4::class)
class WriterTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().context

    private fun read(name: String): ByteArray =
        context.assets.open("corpus/$name").use { it.readBytes() }

    private fun documents(): List<String> =
        context.assets.list("corpus").orEmpty()
            .filter { it.endsWith(".pdf") && !it.startsWith("encrypted_") }
            .sorted()

    private fun text(value: PdfValue): String =
        PdfValue.serialize(value).toString(Charsets.ISO_8859_1)

    // MARK: - Values

    @Test
    fun namesRefsNumbersAndBooleans() {
        assertEquals("/Sig", text(PdfValue.Name("Sig")))
        assertEquals("12 0 R", text(PdfValue.Reference(12)))
        assertEquals("12 3 R", text(PdfValue.Reference(12, 3)))
        assertEquals("42", text(PdfValue.Integer(42)))
        assertEquals("-1.5", text(PdfValue.Real(-1.5)))
        assertEquals("true", text(PdfValue.Bool(true)))
        assertEquals("null", text(PdfValue.Null))
    }

    @Test
    fun arraysAndDictionariesNest() {
        assertEquals(
            "[1 2 3]",
            text(PdfValue.Array(listOf(PdfValue.Integer(1), PdfValue.Integer(2), PdfValue.Integer(3)))),
        )
        assertEquals(
            "<</Type /Sig /Contents 4 0 R>>",
            text(
                PdfValue.Dictionary(
                    listOf("Type" to PdfValue.Name("Sig"), "Contents" to PdfValue.Reference(4)),
                ),
            ),
        )
    }

    @Test
    fun stringsEscapeDelimiters() {
        assertEquals("(a\\(b\\)c\\\\d)", text(PdfValue.Text("a(b)c\\d")))
    }

    @Test
    fun namesEscapeTerminatingCharacters() {
        assertEquals("/a#20b", text(PdfValue.Name("a b")))
        assertEquals("/a#2Fb", text(PdfValue.Name("a/b")))
    }

    @Test
    fun nonAsciiStringsUseUtf16BeWithABom() {
        val out = text(PdfValue.Text("café"))
        assertTrue(out, out.startsWith("<FEFF"))
        assertTrue(out, out.endsWith(">"))
    }

    /**
     * The /Contents placeholder is patched in place once the byte range is known, so its
     * serialised width must be exactly predictable.
     */
    @Test
    fun hexStringsKeepTheirExactByteWidth() {
        assertEquals("<00000000>", text(PdfValue.HexString(ByteArray(4))))
        assertEquals(4096 * 2 + 2, PdfValue.serialize(PdfValue.HexString(ByteArray(4096))).size)
    }

    @Test
    fun indirectObjectWrapsItsValue() {
        val bytes = PdfValue.serialize(PdfValue.Dictionary(listOf("X" to PdfValue.Integer(1))), 7)
        assertEquals("7 0 obj\n<</X 1>>\nendobj\n", bytes.toString(Charsets.ISO_8859_1))
    }

    // MARK: - Scanning

    @Test
    fun everyCorpusDocumentScansWhicheverStyleItUses() {
        val styles = mutableSetOf<XrefStyle>()
        for (file in documents()) {
            val bytes = read(file)
            val info = TrailerInfo.scan(bytes)
            assertTrue(file, info.startXref > 0 && info.startXref < bytes.size)
            assertTrue(file, info.size > 0)
            styles += info.style
        }
        assertEquals(setOf(XrefStyle.TABLE, XrefStyle.STREAM), styles)
    }

    @Test
    fun reportsTheStyleEachDocumentUses() {
        assertEquals(XrefStyle.TABLE, TrailerInfo.scan(read("hello_world.pdf")).style)
        assertEquals(XrefStyle.STREAM, TrailerInfo.scan(read("embedded_attachments.pdf")).style)
    }

    /**
     * bug_455199.pdf declares /Size 6 while its table lists objects 0-6, and its
     * startxref points eight bytes before the xref keyword. Trusting either one
     * overwrites object 6 — the page content stream — and the text silently vanishes.
     */
    @Test
    fun doesNotTrustSizeOrAnExactStartXref() {
        val info = TrailerInfo.scan(read("bug_455199.pdf"))
        assertEquals(XrefStyle.TABLE, info.style)
        assertTrue("must not reuse a live object number", info.nextObjectNumber > 6)
    }

    @Test(expected = PdfError::class)
    fun refusesAnEncryptedDocument() {
        TrailerInfo.scan(read("encrypted_hello_world_r2.pdf"))
    }

    @Test(expected = PdfError::class)
    fun rejectsBytesThatAreNotAPdf() {
        TrailerInfo.scan(byteArrayOf(1, 2, 3))
    }

    // MARK: - Incremental updates

    @Test
    fun originalBytesSurviveAndTheFileOnlyGrows() {
        val base = read("hello_world.pdf")
        val info = TrailerInfo.scan(base)
        val out = PdfWriter.appendUpdate(
            base,
            mapOf(info.nextObjectNumber to PdfValue.Dictionary(listOf("Type" to PdfValue.Name("Unused")))),
        )
        assertTrue(out.size > base.size)
        assertTrue(out.copyOfRange(0, base.size).contentEquals(base))
    }

    @Test
    fun updateCarriesPrevSoTheOriginalXrefStaysReachable() {
        val base = read("hello_world.pdf")
        val out = PdfWriter.appendUpdate(base, emptyMap())
        val tail = out.copyOfRange(base.size, out.size).toString(Charsets.ISO_8859_1)
        assertTrue(tail, tail.contains("/Prev"))
        assertTrue(tail, tail.contains("startxref"))
    }

    /** The acceptance criterion for the whole component: PDFium must still open it. */
    @Test
    fun everyCorpusDocumentStillOpensWithUnchangedContent() = runTest {
        for (file in documents()) {
            val base = read(file)
            val pages: Int
            val text: String
            PdfDocument.open(base).use { before ->
                pages = before.pageCount()
                text = before.page(0).text.string()
            }

            val info = TrailerInfo.scan(base)
            val out = PdfWriter.appendUpdate(
                base,
                mapOf(info.nextObjectNumber to PdfValue.Dictionary(listOf("Type" to PdfValue.Name("Unused")))),
            )

            PdfDocument.open(out).use { after ->
                assertEquals("$file: page count changed", pages, after.pageCount())
                assertEquals("$file: text changed", text, after.page(0).text.string())
            }
        }
    }

    @Test
    fun stackedUpdatesEachKeepTheOneBeforeReachable() = runTest {
        var bytes = read("hello_world.pdf")
        val original = PdfDocument.open(bytes).use { it.page(0).text.string() }
        repeat(3) { round ->
            val info = TrailerInfo.scan(bytes)
            bytes = PdfWriter.appendUpdate(
                bytes,
                mapOf(info.nextObjectNumber to PdfValue.Dictionary(listOf("Round" to PdfValue.Integer(round)))),
            )
        }
        PdfDocument.open(bytes).use { document ->
            assertEquals(1, document.pageCount())
            assertEquals(original, document.page(0).text.string())
        }
    }
}
