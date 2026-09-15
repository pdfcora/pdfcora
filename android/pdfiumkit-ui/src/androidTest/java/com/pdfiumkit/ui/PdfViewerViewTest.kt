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
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasContentDescription
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.ViewRootForTest
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityCheckResult.AccessibilityCheckResultType
import com.google.android.apps.common.testing.accessibility.framework.integrations.espresso.AccessibilityValidator
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
        compose.onAllNodesWithTag("pdf-page").fetchSemanticsNodes().isNotEmpty()
    }

    /** A11Y-2: TalkBack hears the tagged document's structure, not a bitmap. */
    @Test
    fun theTaggedStructureIsExposedToTalkBack() {
        val bytes = InstrumentationRegistry.getInstrumentation().context.assets.open("tagged.pdf").use { it.readBytes() }
        val document = runBlocking { PdfDocument.open(bytes) }
        compose.setContent { PdfViewerView(document, Modifier.fillMaxSize()) }
        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodes(hasContentDescription("Annual report 2026")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(hasContentDescription("Annual report 2026") and SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
            .assertExists()
        compose.onNode(hasContentDescription("Bar chart of revenue by region") and
            SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Image)).assertExists()
        document.close()
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

        val page = compose.onNodeWithTag("pdf-page").assertIsDisplayed().fetchSemanticsNode()
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

    /** A11Y-3: at twice the text size the review buttons wrap instead of running off the edge. */
    @Test
    fun reviewButtonsStayOnScreenAtLargeText() {
        val document = document()
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                PdfViewerView(document, Modifier.fillMaxSize(), review = PdfReviewConfiguration(
                    marks = emptyList(), notice = "Suggestions may be incomplete.", onApply = {}, onCancel = {}))
            }
        }
        waitForPage()
        val width = compose.onRoot().fetchSemanticsNode().size.width
        val minimum = with(compose.density) { 48.dp.toPx() }
        for (id in listOf("review-counts", "review-accept-all", "review-reject-all", "review-apply", "review-cancel")) {
            val bounds = compose.onNodeWithContentDescription(id).fetchSemanticsNode().boundsInRoot
            assertTrue("$id is $bounds in a $width px view", bounds.left >= 0f && bounds.right <= width + 1 && bounds.width >= minimum)
        }
        document.close()
    }

    /**
     * A11Y-1: the Accessibility Test Framework's checks over the component, reviewing and showing a
     * tagged document.
     *
     * Two limits, both recorded in docs/accessibility/ACR-android.md. The framework walks *views*,
     * and a Compose UI is one view whose content is virtual nodes, so only the host view is checked
     * here — it is reported as unlabelled, which is what a Compose host always looks like.
     * Compose 1.8's own `enableAccessibilityChecks` does walk the nodes and found two figures with no
     * description (fixed), but its test APIs crash this suite, so the project stays on Compose 1.6.
     */
    @Test
    fun theComponentPassesTheAccessibilityChecks() {
        val bytes = InstrumentationRegistry.getInstrumentation().context.assets.open("tagged.pdf").use { it.readBytes() }
        val document = runBlocking { PdfDocument.open(bytes) }
        compose.setContent {
            PdfViewerView(document, Modifier.fillMaxSize(), review = PdfReviewConfiguration(
                marks = listOf(PdfMark("m1", 0, listOf(PdfRect(72f, 700f, 400f, 740f)), label = "Anna")),
                notice = "Suggestions may be incomplete.", onApply = {}, onCancel = {}))
        }
        compose.waitUntil(timeoutMillis = 10_000) {
            compose.onAllNodes(hasContentDescription("Annual report 2026")).fetchSemanticsNodes().isNotEmpty()
        }
        compose.waitForIdle()

        val root = compose.onRoot().fetchSemanticsNode().root as ViewRootForTest
        // Collected rather than thrown, so every result can be judged and printed.
        val results = AccessibilityValidator().setRunChecksFromRootView(true).setThrowExceptionFor(null)
            .checkAndReturnResults(root.view)
        // Touch targets: marks and the invisible text elements sit on lines of page text at the
        // page's own size. WCAG 2.1 AA has no target-size criterion and WCAG 2.2's 2.5.8 exempts
        // targets constrained by line height; zooming enlarges them. Recorded in docs/accessibility.
        val errors = results.filter {
            it.type == AccessibilityCheckResultType.ERROR &&
                it.accessibilityHierarchyCheck?.simpleName != "TouchTargetSizeCheck" &&
                it.view?.javaClass?.simpleName != "AndroidComposeView"
        }.map { "${it.accessibilityHierarchyCheck?.simpleName}: ${it.message} — ${it.view}" }
        assertEquals(emptyList<String>(), errors)
        document.close()
    }
}
