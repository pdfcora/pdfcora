package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.cms.CmsSignedData
import com.pdfiumkit.cms.CmsVerifier
import com.pdfiumkit.cms.Der
import com.pdfiumkit.cms.PdfSignatureValidity
import com.pdfiumkit.cms.PdfVerifyOptions
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Mirrors `web/test/{der,signed-data,verify-digest,verify}.test.ts` and the iOS
 * VerificationTests.
 *
 * `pdfsig` reports both of these about the fixture, at the same time:
 *
 *     Signature Validation:   Signature is Valid.
 *     Certificate Validation: Certificate issuer is unknown.
 *
 * Integrity and trust are separate answers. Collapsing them into one is the defect this
 * whole phase exists to avoid, so it is the first verification test.
 */
@RunWith(AndroidJUnit4::class)
class VerificationTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().context

    private fun asset(path: String): ByteArray =
        context.assets.open(path).use { it.readBytes() }

    private fun corpus(name: String) = asset("corpus/$name")
    private fun anchor() = asset("fixtures/unh-iol-signer.der")

    private fun hex(bytes: ByteArray) =
        bytes.joinToString("") { "%02X".format(it) }

    // MARK: - DER

    @Test
    fun readsAShortFormTlv() {
        val bytes = byteArrayOf(0x30, 0x03, 0x02, 0x01, 0x01)   // SEQUENCE { INTEGER 1 }
        val tlv = Der.readTlv(bytes, 0)
        assertEquals(0x30, tlv.tag)
        assertEquals(3, tlv.length)
        assertEquals(5, tlv.end)
        assertEquals(1, Der.children(bytes, tlv).size)
    }

    @Test
    fun readsLongFormLengths() {
        val bytes = byteArrayOf(0x04, 0x82.toByte(), 0x01, 0x2c) + ByteArray(300)
        assertEquals(300, Der.readTlv(bytes, 0).length)
    }

    @Test
    fun decodesAnOid() {
        val bytes = byteArrayOf(
            0x06, 0x09, 0x2a, 0x86.toByte(), 0x48, 0x86.toByte(), 0xf7.toByte(),
            0x0d, 0x01, 0x09, 0x04,
        )
        assertEquals("1.2.840.113549.1.9.4", Der.readOid(bytes, Der.readTlv(bytes, 0)))
    }

    /** The 2.x branch encodes differently from 1.x. */
    @Test
    fun decodesTheSha256Oid() {
        val bytes = byteArrayOf(
            0x06, 0x09, 0x60, 0x86.toByte(), 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
        )
        assertEquals("2.16.840.1.101.3.4.2.1", Der.readOid(bytes, Der.readTlv(bytes, 0)))
    }

    @Test(expected = Der.Failure::class)
    fun refusesALengthPastTheBuffer() {
        Der.readTlv(byteArrayOf(0x30, 0x7f), 0)
    }

    @Test(expected = Der.Failure::class)
    fun refusesAnIndefiniteLength() {
        Der.readTlv(byteArrayOf(0x30, 0x80.toByte(), 0x00, 0x00), 0)
    }

    @Test(expected = Der.Failure::class)
    fun refusesAnEmptyBuffer() {
        Der.readTlv(ByteArray(0), 0)
    }

    // MARK: - SignedData

    private suspend fun signature(): PdfSignature =
        PdfDocument.open(corpus("signed_unh_iol.pdf")).use { it.signatures().first() }

    /**
     * Compared byte for byte against what OpenSSL extracts from the same blob, so the
     * certificate boundaries are confirmed by a tool that does not share our parser.
     */
    @Test
    fun extractsTheCertificateExactlyAsOpenSslDoes() = runTest {
        val cms = CmsSignedData.parse(signature().contents)
        assertEquals(1, cms.certificates.size)
        assertArrayEquals(anchor(), cms.certificates[0])
    }

    @Test
    fun extractsTheAlgorithms() = runTest {
        val cms = CmsSignedData.parse(signature().contents)
        assertEquals("2.16.840.1.101.3.4.2.1", cms.digestAlgorithm)      // sha256
        assertEquals("1.2.840.113549.1.1.11", cms.signatureAlgorithm)    // sha256WithRSA
    }

    @Test
    fun extractsTheSignerSerial() = runTest {
        assertEquals("4BB35DB9A6994675E459", hex(CmsSignedData.parse(signature().contents).signerSerial))
    }

    @Test
    fun extractsTheMessageDigestAttribute() = runTest {
        val digest = CmsSignedData.parse(signature().contents).messageDigest!!
        assertEquals(32, digest.size)
        assertEquals(
            "9F9DF165ED1A251D0644F7DE9B1BC1C71328D4F139209F1BD28336E9D1FEFD73",
            hex(digest),
        )
    }

    /**
     * The signature is computed over the SET encoding, not the `[0] IMPLICIT` form the
     * file stores. Returning the stored bytes makes every signature appear invalid.
     */
    @Test
    fun signedAttributesAreRetaggedAsASet() = runTest {
        val attrs = CmsSignedData.parse(signature().contents).signedAttrs!!
        assertEquals("must be SET (0x31), not [0] IMPLICIT (0xa0)", 0x31, attrs[0].toInt() and 0xff)
        assertEquals(94, attrs.size)
    }

    @Test(expected = Der.Failure::class)
    fun rejectsABlobThatIsNotSignedData() {
        CmsSignedData.parse(byteArrayOf(0x30, 0x03, 0x02, 0x01, 0x01))
    }

    // MARK: - Verification

    @Test
    fun theSignedRangesHashToTheMessageDigest() = runTest {
        val bytes = corpus("signed_unh_iol.pdf")
        val sig = signature()
        val cms = CmsSignedData.parse(sig.contents)
        val digest = CmsVerifier.digestOverRanges(bytes, sig.byteRange, "SHA-256")
        assertArrayEquals(cms.messageDigest, digest)
    }

    @Test
    fun aValidSignatureFromAnUnknownIssuerIsUntrusted() = runTest {
        PdfDocument.open(corpus("signed_unh_iol.pdf")).use { document ->
            val verdict = document.verify(document.signatures().first())
            assertTrue("expected Untrusted, got $verdict", verdict is PdfSignatureValidity.Untrusted)
            val untrusted = verdict as PdfSignatureValidity.Untrusted
            assertTrue(untrusted.chain.isNotEmpty())
            assertEquals("UNH-IOL", untrusted.chain[0].commonName)
        }
    }

    @Test
    fun theSameSignatureIsValidOnceItsCertificateIsAnAnchor() = runTest {
        PdfDocument.open(corpus("signed_unh_iol.pdf")).use { document ->
            val verdict = document.verify(
                document.signatures().first(),
                PdfVerifyOptions(trustAnchors = listOf(anchor())),
            )
            assertTrue("expected Valid, got $verdict", verdict is PdfSignatureValidity.Valid)
            assertEquals("UNH-IOL", (verdict as PdfSignatureValidity.Valid).signer.commonName)
        }
    }

    /** Tampering is an integrity failure and must not be reported as a trust problem. */
    @Test
    fun aChangedByteIsADigestMismatchNotUntrusted() = runTest {
        val tampered = corpus("signed_unh_iol.pdf").also { it[100] = (it[100].toInt() xor 0xff).toByte() }
        PdfDocument.open(tampered).use { document ->
            assertEquals(
                PdfSignatureValidity.DigestMismatch,
                document.verify(document.signatures().first()),
            )
        }
    }

    /** …and it stays a mismatch even when the signer is fully trusted. */
    @Test
    fun aTrustedAnchorDoesNotRescueATamperedDocument() = runTest {
        val tampered = corpus("signed_unh_iol.pdf").also { it[100] = (it[100].toInt() xor 0xff).toByte() }
        PdfDocument.open(tampered).use { document ->
            assertEquals(
                PdfSignatureValidity.DigestMismatch,
                document.verify(
                    document.signatures().first(),
                    PdfVerifyOptions(trustAnchors = listOf(anchor())),
                ),
            )
        }
    }

    /**
     * The digest check runs first and catches a changed document, so this corrupts only
     * the RSA signature value — leaving the messageDigest intact — to prove the signature
     * itself is actually verified rather than assumed.
     *
     * `contents` is the whole /Contents placeholder, zero-padded by the signer, so the
     * signature value is located inside the blob rather than indexed from its end.
     */
    @Test
    fun aCorruptedSignatureValueFailsEvenWhenTheDigestMatches() = runTest {
        PdfDocument.open(corpus("signed_unh_iol.pdf")).use { document ->
            val sig = document.signatures().first()
            val cms = CmsSignedData.parse(sig.contents)
            val contents = sig.contents.copyOf()
            val at = indexOf(cms.signature, contents)
            assertTrue("the signature value must be findable in the blob", at >= 0)
            contents[at + 8] = (contents[at + 8].toInt() xor 0xff).toByte()

            val forged = sig.copy(contents = contents)
            assertEquals(
                PdfSignatureValidity.DigestMismatch,
                document.verify(forged, PdfVerifyOptions(trustAnchors = listOf(anchor()))),
            )
        }
    }

    /**
     * PDFium hands back the whole /Contents placeholder, which a signer pads with zeros
     * to a fixed reserved size. Anything indexing from the end indexes into padding.
     */
    @Test
    fun contentsIsThePaddedPlaceholderNotJustTheDer() = runTest {
        val contents = signature().contents
        val der = Der.readTlv(contents, 0)
        assertTrue(der.end < contents.size)
        assertTrue(contents.drop(der.end).all { it == 0.toByte() })
    }

    @Test
    fun aMalformedPkcs7IsReportedNotThrown() = runTest {
        PdfDocument.open(corpus("signed_unh_iol.pdf")).use { document ->
            val broken = document.signatures().first().copy(contents = byteArrayOf(1, 2, 3))
            assertTrue(document.verify(broken) is PdfSignatureValidity.Malformed)
        }
    }

    private fun indexOf(needle: ByteArray, haystack: ByteArray): Int {
        if (needle.isEmpty() || haystack.size < needle.size) return -1
        outer@ for (start in 0..(haystack.size - needle.size)) {
            for (i in needle.indices) if (haystack[start + i] != needle[i]) continue@outer
            return start
        }
        return -1
    }
}
