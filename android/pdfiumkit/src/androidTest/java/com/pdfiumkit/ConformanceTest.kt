package com.pdfiumkit

import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest

/**
 * Runs the same corpus and expectations the iOS and Web SDKs are tested against, so
 * "the three SDKs behave identically" is checked rather than assumed.
 */
@RunWith(AndroidJUnit4::class)
class ConformanceTest {

    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets

    private fun corpus(name: String): ByteArray =
        assets.open("corpus/$name").use { it.readBytes() }

    private fun expectations(): JSONObject =
        JSONObject(assets.open("expectations.json").use { it.readBytes().decodeToString() })

    @Test
    fun engineRevisionMatchesExpectations() {
        assertEquals(expectations().getString("engine"), PdfDocument.ENGINE_VERSION)
    }

    @Test
    fun allCorpusDocumentsMatchExpectations() = runTest {
        val documents = expectations().getJSONObject("documents")
        val names = documents.keys().asSequence().toList()
        assertTrue("expectations.json is empty", names.isNotEmpty())

        for (name in names) {
            val expected = documents.getJSONObject(name)
            val bytes = corpus(name)

            if (!expected.getBoolean("opens")) {
                try {
                    PdfDocument.open(bytes).close()
                    fail("$name: expected open to fail with ${expected.optString("openError")}")
                } catch (e: PdfError) {
                    assertOpenError(name, e, expected.optString("openError"))
                }
                continue
            }

            PdfDocument.open(bytes).use { document ->
                assertEquals("$name: page count", expected.getInt("pageCount"), document.pageCount())

                val pages = expected.optJSONArray("pages") ?: return@use
                for (i in 0 until pages.length()) {
                    val expectedPage = pages.getJSONObject(i)
                    val page = document.page(i)
                    val size = page.size()
                    assertEquals("$name page $i width",
                        expectedPage.getDouble("width"), size.width.toDouble(), 0.01)
                    assertEquals("$name page $i height",
                        expectedPage.getDouble("height"), size.height.toDouble(), 0.01)

                    if (expectedPage.has("charCount")) {
                        assertEquals("$name page $i character count",
                            expectedPage.getInt("charCount"), page.text.characterCount())
                    }
                    val expectedHash = expectedPage.optString("textSha256", "")
                    if (expectedHash.isNotEmpty()) {
                        val text = page.text.string()
                        assertEquals(
                            "$name page $i text differs from the reference engine; " +
                                "got ${text.take(60)}",
                            expectedHash, textHash(text)
                        )
                        val anchors = expectedPage.optJSONArray("textContains")
                        for (a in 0 until (anchors?.length() ?: 0)) {
                            val anchor = anchors!!.getString(a)
                            assertTrue("$name page $i missing expected text $anchor",
                                collapsed(text).contains(anchor))
                        }
                    }
                }
            }
        }
    }

    /** Must match conformance/generate.mjs exactly — see the note there on portability. */
    private val stripped = setOf(
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x2028, 0x2029, 0x202f, 0x3000
    )

    private fun normalize(text: String): String {
        val out = StringBuilder(text.length)
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            if (cp !in stripped) out.appendCodePoint(cp)
            i += Character.charCount(cp)
        }
        return out.toString()
    }

    private fun textHash(text: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(normalize(text).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /** Whitespace collapsed to single spaces, for the human-readable anchor only. */
    private fun collapsed(text: String): String =
        text.map { if (it.isWhitespace()) ' ' else it }
            .joinToString("").trim().replace(Regex(" +"), " ")

    private fun assertOpenError(name: String, error: PdfError, expected: String) {
        val matches = when (error) {
            is PdfError.PasswordRequired, is PdfError.WrongPassword -> expected == "password"
            is PdfError.Corrupt -> expected == "format" || expected == "file"
            is PdfError.UnsupportedSecurity -> expected == "security"
            else -> false
        }
        assertTrue("$name: error $error does not match expected $expected", matches)
    }

    /**
     * PDFium writes BGRA; Android's ARGB_8888 is RGBA in memory, and the JNI bridge
     * swaps the channels. These coordinates come from rendering the same page with the
     * WASM build, so a swap in the wrong direction turns blue into red and fails here.
     * Counting alone would not catch it — the page has equal numbers of red and blue.
     */
    @Test
    fun renderedChannelOrderMatchesReferenceEngine() = runTest {
        PdfDocument.open(corpus("rectangles.pdf")).use { document ->
            val bitmap = document.page(0).render(pixelWidth = 200, pixelHeight = 300)
            assertEquals("blue region", Color.BLUE, bitmap.getPixel(99, 50))
            assertEquals("green region", Color.GREEN, bitmap.getPixel(156, 142))
            assertEquals("red region", Color.RED, bitmap.getPixel(90, 221))
        }
    }

    @Test
    fun renderedPageIsNotBlank() = runTest {
        PdfDocument.open(corpus("rectangles.pdf")).use { document ->
            val bitmap = document.page(0).render(width = 100)
            val distinct = mutableSetOf<Int>()
            for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
                distinct += bitmap.getPixel(x, y)
            }
            assertTrue("rendered page appears blank", distinct.size > 1)
        }
    }

    @Test
    fun renderHonoursAspectRatio() = runTest {
        PdfDocument.open(corpus("combobox_form.pdf")).use { document ->
            val bitmap = document.page(0).render(width = 300)
            assertEquals(300, bitmap.width)
            assertEquals(600, bitmap.height)   // page is 300x600 points
        }
    }
}
