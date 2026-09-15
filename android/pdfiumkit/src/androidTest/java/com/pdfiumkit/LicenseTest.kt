package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.license.PdfLicense
import com.pdfiumkit.license.PdfLicenseStatus
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
}
