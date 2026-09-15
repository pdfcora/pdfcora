package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.license.PdfLicense
import com.pdfiumkit.license.PdfLicenseStatus
import com.pdfiumkit.sign.PdfSignOptions
import com.pdfiumkit.sign.sign
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

internal object LicenseFixture {
    val json: JSONObject by lazy {
        JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("license/cases.json").use { it.readBytes().decodeToString() })
    }

    fun installFullKey() {
        PdfLicense.configureForTesting(
            publicKey = json.getString("publicKey"),
            revoked = (0 until json.getJSONArray("revoked").length()).map { json.getJSONArray("revoked").getString(it) }.toSet(),
            releaseDate = json.getString("releaseDate"),
            appIdentifier = json.getString("app"),
            key = json.getString("fullKey"), setKey = true,
        )
    }
}

@RunWith(AndroidJUnit4::class)
class LicenseTest {
    @After fun restore() = LicenseFixture.installFullKey()

    @Test fun sharedCases() {
        val fixture = LicenseFixture.json
        val cases = fixture.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val status = PdfLicense.configureForTesting(
                publicKey = fixture.getString("publicKey"),
                revoked = setOf("lic_revoked"),
                releaseDate = fixture.getString("releaseDate"),
                appIdentifier = fixture.getString("app"),
                key = if (c.isNull("key")) null else c.getString("key"), setKey = true,
            )
            val expected = c.getJSONObject("expected").getJSONObject("android")
            when (status) {
                is PdfLicenseStatus.Licensed -> {
                    assertEquals("$name: $status", "licensed", expected.getString("kind"))
                    val modules = expected.getJSONArray("modules")
                    assertEquals(name, (0 until modules.length()).map { modules.getString(it) },
                                 status.modules.map { it.id }.sorted())
                }
                is PdfLicenseStatus.Trial -> {
                    assertEquals("$name: ${status.message}", "trial", expected.getString("kind"))
                    assertEquals("$name: ${status.message}", expected.getString("reason"), status.reason.id)
                }
            }
        }
    }

    private val mark = "PdfiumKit trial"
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private fun corpus(name: String) = assets.open("corpus/$name").use { it.readBytes() }
    private fun use(key: String?) { PdfLicense.configureForTesting(key = key, setKey = true) }
    private fun keyWith(modules: String): String =
        JSONObject(assets.open("license/partial-keys.json").use { it.readBytes().decodeToString() }).getString(modules)

    private suspend fun texts(bytes: ByteArray): List<String> = PdfDocument.open(bytes).use { d ->
        (0 until d.pageCount()).map { d.page(it).text.string() }
    }

    private fun greyPixels(bitmap: android.graphics.Bitmap): Int {
        var count = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val p = bitmap.getPixel(x, y)
            val (r, g, b) = Triple(p shr 16 and 0xff, p shr 8 and 0xff, p and 0xff)
            if (r in 151..249 && kotlin.math.abs(r - g) < 8 && kotlin.math.abs(g - b) < 8) count++
        }
        return count
    }

    @Test fun trialRenderIsWatermarked() = kotlinx.coroutines.runBlocking {
        val licensed = PdfDocument.open(corpus("hello_world.pdf")).use { it.page(0).render(400) }
        use(null)
        val trial = PdfDocument.open(corpus("hello_world.pdf")).use { it.page(0).render(400) }
        org.junit.Assert.assertTrue(greyPixels(trial) > greyPixels(licensed) + 500)
    }

    @Test fun trialSaveIsWatermarkedOnEveryPage() = kotlinx.coroutines.runBlocking {
        use(null)
        val trial = PdfDocument.open(corpus("hello_world_2_pages_split_streams.pdf")).use { it.toByteArray() }
        texts(trial).forEach { org.junit.Assert.assertTrue(it.contains(mark)) }
        LicenseFixture.installFullKey()
        val licensed = PdfDocument.open(corpus("hello_world_2_pages_split_streams.pdf")).use { it.toByteArray() }
        texts(licensed).forEach { org.junit.Assert.assertFalse(it.contains(mark)) }
    }

    @Test fun savingTwiceStampsOnce() = kotlinx.coroutines.runBlocking {
        use(null)
        PdfDocument.open(corpus("hello_world.pdf")).use { d ->
            d.toByteArray()
            assertEquals(1, texts(d.toByteArray())[0].split(mark).size - 1)
        }
    }

    @Test fun incrementalSaveOfMarkedDocumentIsFullAndWatermarked() = kotlinx.coroutines.runBlocking {
        use(null)
        val original = corpus("hello_world.pdf")
        val saved = PdfDocument.open(original).use { it.toByteArray(PdfSaveMode.INCREMENTAL) }
        org.junit.Assert.assertFalse(saved.copyOfRange(0, original.size).contentEquals(original))
        org.junit.Assert.assertTrue(texts(saved)[0].contains(mark))
    }

    @Test fun unlicensedModuleMarksTheDocument() = kotlinx.coroutines.runBlocking {
        use(keyWith("forms"))
        PdfDocument.open(corpus("hello_world.pdf")).use { d ->
            org.junit.Assert.assertFalse(d.needsWatermark)
            d.page(0).addNote(PdfRect(10f, 10f, 30f, 30f), "x")
            org.junit.Assert.assertTrue(d.needsWatermark)
        }
    }

    @Test fun unlicensedRedactionStillRemovesText() = kotlinx.coroutines.runBlocking {
        use(keyWith(""))
        PdfDocument.open(corpus("hello_world.pdf")).use { d ->
            d.redact(listOf(PdfRedactionTarget.TextMatches("Hello")))
            val text = texts(d.toByteArray())[0]
            org.junit.Assert.assertFalse(text.contains("Hello"))
            org.junit.Assert.assertTrue(text.contains(mark))
        }
    }

    /** pdfsig runs on the host over this file; see scripts/test-android.sh. */
    @Test fun writesAnUnlicensedSignedDocumentForTheHost() = kotlinx.coroutines.runBlocking {
        use(keyWith(""))
        val signer = com.pdfiumkit.sign.Pkcs12Signer(assets.open("fixtures/test-signer.p12").use { it.readBytes() }, "pdfiumkit")
        val signed = PdfDocument.open(corpus("hello_world.pdf")).use { it.sign(PdfSignOptions(signer)) }
        org.junit.Assert.assertTrue(texts(signed)[0].contains(mark))
        java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
                     "pdfiumkit-android-trial-signed.pdf").writeBytes(signed)
    }
}
