package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.writer.PdfValue
import com.pdfiumkit.writer.PdfWriter
import com.pdfiumkit.writer.TrailerInfo
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Calendar
import java.util.TimeZone

/**
 * Mirrors `web/test/signatures.test.ts` and `ios/Tests/PdfiumKitTests/SignatureTests.swift`.
 *
 * Expectations come from `pdfsig`, not from this SDK, so a bug here cannot be confirmed
 * by a matching bug in our own reader:
 *
 *     Signer Certificate Common Name: UNH-IOL
 *     Signing Time: Jan 05 2026 16:23:15
 *     Signature Type: adbe.pkcs7.detached
 *     Signed Ranges: [0 - 151484], [156392 - 297957]
 *     Total document signed
 */
@RunWith(AndroidJUnit4::class)
class SignatureTest {

    private fun read(name: String): ByteArray =
        InstrumentationRegistry.getInstrumentation().context.assets
            .open("corpus/$name").use { it.readBytes() }

    @Test
    fun readsTheSignatureOfARealSignedDocument() = runTest {
        PdfDocument.open(read("signed_unh_iol.pdf")).use { document ->
            val signatures = document.signatures()
            assertEquals(1, signatures.size)

            val signature = signatures.first()
            assertEquals("adbe.pkcs7.detached", signature.subFilter)
            assertEquals(listOf(0, 151484, 156392, 141565), signature.byteRange)
            assertTrue("the PKCS#7 blob must come back", signature.contents.isNotEmpty())
        }
    }

    @Test
    fun reportsTheSigningTimeTheSignerClaimed() = runTest {
        PdfDocument.open(read("signed_unh_iol.pdf")).use { document ->
            val signingTime = document.signatures().first().signingTime
            assertNotNull(signingTime)

            val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
            calendar.time = signingTime!!
            assertEquals(2026, calendar.get(Calendar.YEAR))
            assertEquals(Calendar.JANUARY, calendar.get(Calendar.MONTH))
            assertEquals(5, calendar.get(Calendar.DAY_OF_MONTH))
        }
    }

    @Test
    fun anUnsignedDocumentReportsNoSignatures() = runTest {
        PdfDocument.open(read("hello_world.pdf")).use { document ->
            assertTrue(document.signatures().isEmpty())
        }
    }

    /** pdfsig says "Total document signed": the last byte range span ends at EOF. */
    @Test
    fun reportsThatTheSignatureCoversTheWholeFile() = runTest {
        PdfDocument.open(read("signed_unh_iol.pdf")).use { document ->
            assertTrue(document.signatures().first().coversWholeDocument)
        }
    }

    /**
     * Computed, not read, and getting it wrong is the failure that lets a signed
     * document be silently amended.
     */
    @Test
    fun aSignatureThatStopsShortOfEofIsNotReportedAsCoveringIt() = runTest {
        val base = read("signed_unh_iol.pdf")
        val info = TrailerInfo.scan(base)
        // Amend the document after it was signed, exactly as an attacker would.
        val amended = PdfWriter.appendUpdate(
            base,
            mapOf(info.nextObjectNumber to PdfValue.Dictionary(listOf("Type" to PdfValue.Name("Unused")))),
        )

        PdfDocument.open(amended).use { document ->
            val signatures = document.signatures()
            assertTrue("the signature must still be found after the amendment", signatures.isNotEmpty())
            assertFalse(
                "content was appended after the signed range",
                signatures.first().coversWholeDocument,
            )
        }
    }
}
