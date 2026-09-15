package com.pdfiumkit.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.PdfDocument
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PdfViewerViewTest {
    @get:Rule
    val compose = createComposeRule()

    /**
     * Found by the basic sample, whose first version closed its document too early: the
     * error from opening the viewer escaped the composition and took the whole app down.
     */
    @Test
    fun aDocumentThatCannotBeViewedShowsAnErrorInsteadOfCrashingTheApp() {
        val bytes = InstrumentationRegistry.getInstrumentation().context.assets.open("hello_world.pdf").use { it.readBytes() }
        val document = runBlocking { PdfDocument.open(bytes) }
        document.close()

        compose.setContent { PdfViewerView(document, Modifier.fillMaxSize()) }

        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithText("closed", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
    }
}
