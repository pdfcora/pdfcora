package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.cms.PdfSignatureValidity
import com.pdfiumkit.cms.PdfVerifyOptions
import com.pdfiumkit.sign.PdfSignOptions
import com.pdfiumkit.sign.Pkcs12Signer
import com.pdfiumkit.sign.SignatureField
import com.pdfiumkit.sign.sign
import com.pdfiumkit.writer.Flate
import com.pdfiumkit.writer.PdfReader
import com.pdfiumkit.writer.Xref
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.zip.Deflater

/**
 * Mirrors `web/test/{xref,read-object,sign-field,sign}.test.ts` and the iOS SigningTests.
 *
 * The gate is `pdfsig`, but an instrumented test cannot run it: the emulator has no
 * poppler. The suite writes a signed document to the device and `scripts/test-android.sh`
 * pulls it and runs the gate on the host. Asking only our own verifier would prove
 * nothing, since signer and verifier share any bug.
 */
@RunWith(AndroidJUnit4::class)
class SigningTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().context

    private fun asset(path: String): ByteArray = context.assets.open(path).use { it.readBytes() }
    private fun corpus(name: String) = asset("corpus/$name")

    private fun documents(): List<String> =
        context.assets.list("corpus").orEmpty()
            .filter { it.endsWith(".pdf") && !it.startsWith("encrypted_") }
            .sorted()

    private fun signer() = Pkcs12Signer(asset("fixtures/test-signer.p12"), "pdfiumkit")
    private fun anchor() = asset("fixtures/test-signer.der")

    // MARK: - Inflate and xref

    @Test
    fun inflateRoundTrips() {
        val original = "stream contents ".repeat(40).toByteArray()
        val deflater = Deflater().apply { setInput(original); finish() }
        val buffer = ByteArray(original.size * 2 + 64)
        val written = deflater.deflate(buffer)
        deflater.end()

        assertArrayEquals(original, Flate.inflate(buffer.copyOf(written)))
    }

    @Test
    fun locatesEveryObjectInAClassicTable() {
        // hello_world.pdf's table declares "0 7", so objects 1..6 exist.
        val xref = Xref.build(corpus("hello_world.pdf"))
        for (number in 1..6) assertNotNull("object $number", xref[number])
    }

    @Test
    fun locatesAnObjectInsideAnObjectStream() {
        val xref = Xref.build(corpus("bug_707673.pdf"))
        assertTrue(
            "this file must exercise the object-stream path",
            xref.values.any { it is Xref.Entry.InObjectStream },
        )
    }

    /**
     * The whole corpus, because a subset missed a precedence bug on the web side: only
     * documents whose startxref sits late in a big file failed.
     */
    @Test
    fun everyCorpusDocumentYieldsANonEmptyMap() {
        val files = documents()
        assertTrue("the sweep must cover the corpus", files.size >= 19)
        for (file in files) assertTrue(file, Xref.build(corpus(file)).isNotEmpty())
    }

    /**
     * Cross-reference streams are routinely PNG-predicted. Inflating without undoing it
     * yields plausible bytes and completely wrong offsets.
     */
    @Test
    fun everyCorpusDocumentYieldsItsCatalog() {
        for (file in documents()) {
            val (_, value) = PdfReader.catalog(corpus(file))
            assertTrue("$file: /Type /Catalog", PdfReader.isName(PdfReader.entry(value, "Type"), "Catalog"))
        }
    }

    /** /AcroForm may be inline or a reference, and real files use both. */
    @Test
    fun readsAnAcroFormWhetherInlineOrAReference() {
        val bytes = corpus("text_form.pdf")
        val (_, catalog) = PdfReader.catalog(bytes)
        val xref = Xref.build(bytes)

        val acroForm = PdfReader.reference(catalog, "AcroForm")
            ?.let { PdfReader.obj(bytes, xref, it) }
            ?: PdfReader.entry(catalog, "AcroForm")

        assertNotNull("text_form.pdf has an AcroForm", acroForm)
        assertNotNull(PdfReader.entry(acroForm, "Fields"))
    }

    // MARK: - Field placement

    @Test
    fun pdfiumSeesASignatureWhereThereWasNone() = runTest {
        val placed = SignatureField.place(corpus("hello_world.pdf"), SignatureField.Options())
        PdfDocument.open(placed.bytes).use { document ->
            assertEquals("ETSI.CAdES.detached", document.signatures().first().subFilter)
        }
    }

    /** Off by one byte here and the signature protects the wrong span. */
    @Test
    fun theByteRangeBracketsThePlaceholderExactly() {
        val placed = SignatureField.place(corpus("hello_world.pdf"), SignatureField.Options())
        assertEquals(0, placed.byteRange[0])
        assertEquals(placed.contentsAt, placed.byteRange[1])
        assertEquals(placed.contentsAt + placed.contentsLength, placed.byteRange[2])
        assertEquals(placed.bytes.size, placed.byteRange[2] + placed.byteRange[3])
    }

    @Test
    fun anExistingAcroFormIsExtendedNotReplaced() = runTest {
        val before = PdfDocument.open(corpus("text_form.pdf")).use { it.page(0).formFields().size }
        assertTrue(before > 0)

        val placed = SignatureField.place(corpus("text_form.pdf"), SignatureField.Options())
        val after = PdfDocument.open(placed.bytes).use { it.page(0).formFields().size }
        assertEquals("the original fields must survive", before + 1, after)
    }

    // MARK: - Signing

    @Test
    fun aSignedDocumentVerifiesWithOurOwnVerifier() = runTest {
        val signed = PdfDocument.open(corpus("hello_world.pdf")).use {
            it.sign(PdfSignOptions(signer = signer(), reason = "Approved"))
        }

        PdfDocument.open(signed).use { document ->
            val signature = document.signatures().first()
            assertTrue(signature.coversWholeDocument)
            val verdict = document.verify(signature, PdfVerifyOptions(trustAnchors = listOf(anchor())))
            assertTrue("expected Valid, got $verdict", verdict is PdfSignatureValidity.Valid)
        }
    }

    @Test
    fun tamperingIsDetected() = runTest {
        val signed = PdfDocument.open(corpus("hello_world.pdf")).use {
            it.sign(PdfSignOptions(signer = signer()))
        }
        signed[100] = (signed[100].toInt() xor 0xff).toByte()

        PdfDocument.open(signed).use { document ->
            val verdict = document.verify(
                document.signatures().first(),
                PdfVerifyOptions(trustAnchors = listOf(anchor())),
            )
            assertEquals(PdfSignatureValidity.DigestMismatch, verdict)
        }
    }

    /** Self-signed, so it is cryptographically sound and untrusted at once. */
    @Test
    fun withoutAnAnchorOurOwnSignatureIsUntrusted() = runTest {
        val signed = PdfDocument.open(corpus("hello_world.pdf")).use {
            it.sign(PdfSignOptions(signer = signer()))
        }
        PdfDocument.open(signed).use { document ->
            assertTrue(document.verify(document.signatures().first()) is PdfSignatureValidity.Untrusted)
        }
    }

    /** The property the append-only writer exists for. */
    @Test
    fun signingTwiceLeavesTheFirstSignatureIntact() = runTest {
        val once = PdfDocument.open(corpus("hello_world.pdf")).use {
            it.sign(PdfSignOptions(signer = signer()))
        }
        val twice = PdfDocument.open(once).use { it.sign(PdfSignOptions(signer = signer())) }

        PdfDocument.open(twice).use { document ->
            val signatures = document.signatures()
            assertEquals(2, signatures.size)
            assertFalse("the first no longer covers all", signatures[0].coversWholeDocument)
            assertTrue(signatures[1].coversWholeDocument)

            for (signature in signatures) {
                val verdict = document.verify(
                    signature, PdfVerifyOptions(trustAnchors = listOf(anchor())),
                )
                assertTrue("signature ${signature.index}: $verdict", verdict is PdfSignatureValidity.Valid)
            }
        }
    }

    /** Too small a placeholder must fail loudly; silent truncation corrupts the file. */
    @Test
    fun aSignatureThatWillNotFitIsRefused() = runTest {
        PdfDocument.open(corpus("hello_world.pdf")).use { document ->
            val error = runCatching {
                document.sign(PdfSignOptions(signer = signer(), reservedBytes = 64))
            }.exceptionOrNull()
            assertTrue("expected a refusal, got $error", error?.message?.contains("reserved") == true)
        }
    }

    /**
     * The host cross-check. An instrumented test cannot run pdfsig, so the signed
     * document is written where scripts/test-android.sh can pull it.
     */
    @Test
    fun writesASignedDocumentForTheHostToCrossCheck() = runTest {
        val signed = PdfDocument.open(corpus("hello_world.pdf")).use {
            it.sign(PdfSignOptions(signer = signer()))
        }
        val target = File(
            InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
            "pdfiumkit-android-signed.pdf",
        )
        target.writeBytes(signed)
        assertTrue("the host cross-check needs this file", target.exists())
    }
}

/**
 * The signing contract, asserted identically on all three platforms.
 *
 * Web supplies its own CMS implementation while iOS and Android build one natively, so
 * the mechanism differs — but the properties a signed document must have do not, and that
 * is what this pins.
 */
@RunWith(AndroidJUnit4::class)
class SigningContractTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().context
    private fun asset(path: String) = context.assets.open(path).use { it.readBytes() }

    @Test
    fun aSignedDocumentMeetsTheContract() = runTest {
        val base = asset("corpus/hello_world.pdf")
        val before = PdfDocument.open(base).use { it.page(0).text.string() }

        val signed = PdfDocument.open(base).use {
            it.sign(PdfSignOptions(signer = Pkcs12Signer(asset("fixtures/test-signer.p12"), "pdfiumkit")))
        }

        PdfDocument.open(signed).use { document ->
            val signatures = document.signatures()
            assertEquals("exactly one signature", 1, signatures.size)
            assertEquals("ETSI.CAdES.detached", signatures[0].subFilter)
            assertTrue(signatures[0].coversWholeDocument)

            val anchor = asset("fixtures/test-signer.der")
            assertTrue(
                document.verify(signatures[0], PdfVerifyOptions(trustAnchors = listOf(anchor)))
                    is PdfSignatureValidity.Valid,
            )
            // Self-signed, so without the anchor it is sound but untrusted — never valid.
            assertTrue(document.verify(signatures[0]) is PdfSignatureValidity.Untrusted)

            // The content must survive signing untouched.
            assertEquals(before, document.page(0).text.string())
        }
    }
}
