package com.pdfiumkit.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.PdfDocument
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import androidx.compose.ui.test.performClick
import com.pdfiumkit.PdfRect
import com.pdfiumkit.view.PdfMark
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PdfViewerViewTest {
    @get:Rule
    val compose = createComposeRule()

    private fun document(): PdfDocument {
        val bytes = InstrumentationRegistry.getInstrumentation().context.assets.open("hello_world.pdf").use { it.readBytes() }
        return runBlocking { PdfDocument.open(bytes) }
    }

    private fun waitForPage() = compose.waitUntil(timeoutMillis = 5_000) {
        compose.onAllNodesWithContentDescription("Page").fetchSemanticsNodes().isNotEmpty()
    }

    /**
     * Fit width draws the page as wide as the view, one bitmap pixel per screen pixel. A
     * page rendered in dp instead of pixels would come out a density factor too narrow or
     * be stretched — the iOS and web components had exactly that bug.
     */
    @Test
    fun thePageIsRenderedAtTheViewWidthInScreenPixels() {
        val document = document()
        compose.setContent { PdfViewerView(document, Modifier.fillMaxSize()) }
        waitForPage()

        val page = compose.onNodeWithContentDescription("Page").assertIsDisplayed().fetchSemanticsNode()
        val root = compose.onRoot().fetchSemanticsNode()
        assertTrue("page is ${page.size.width}px wide in a ${root.size.width}px view",
                   kotlin.math.abs(page.size.width - root.size.width) <= 2)
        document.close()
    }

    /**
     * Every item in the default toolbar can be brought on screen and tapped. The row scrolls
     * rather than wraps, so an item past the edge is not a bug — one that cannot be reached is.
     */
    @Test
    fun everyDefaultToolbarItemCanBeReachedAndTapped() {
        val document = document()
        compose.setContent { PdfViewerView(document, Modifier.fillMaxSize()) }
        waitForPage()

        val ids = PdfToolbarConfiguration.Default.items
            .filterNot { it == PdfToolbarItem.Spacer || it == PdfToolbarItem.Divider }
            .map { it.id }
        for (id in ids) {
            compose.onNodeWithContentDescription(id).performScrollTo().assertIsDisplayed().assertHasClickAction()
        }
        document.close()
    }

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

    /** Review mode: a mark over the page, tapped once to accept, then applied. */
    @Test
    fun aTappedMarkIsAcceptedAndApplyHandsOverItsId() {
        val document = document()
        var applied: List<String>? = null
        compose.setContent {
            PdfViewerView(document, Modifier.fillMaxSize(), review = PdfReviewConfiguration(
                marks = listOf(PdfMark("m1", 0, listOf(PdfRect(0f, 0f, 612f, 792f)), label = "Anna")),
                notice = "Suggestions may be incomplete. Review the whole document.",
                onApply = { applied = it },
            ))
        }
        waitForPage()
        compose.onNodeWithContentDescription("review-notice").assertIsDisplayed()
        compose.onNodeWithText("Anna", useUnmergedTree = true).assertExists()
        compose.onNodeWithContentDescription("mark-m1").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("1 accepted", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("review-apply").performClick()
        compose.waitUntil(5_000) { applied != null }
        assertEquals(listOf("m1"), applied)
        document.close()
    }
}
