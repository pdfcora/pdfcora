package com.pdfcora.ai

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The same assertions as the `web-ai/test` suites and `ios/Tests/PDFCoraAITests`.
 *
 * If a test here needs different assertions than its twin on another platform, the
 * implementations have diverged and one of them is wrong.
 */
class ContractTest {

    // MARK: - Availability

    @Test
    fun onlyAvailableIsUsable() {
        assertTrue(PdfAiAvailability.Available.isUsable)
        assertFalse(PdfAiAvailability.Downloadable.isUsable)
        assertFalse(PdfAiAvailability.Downloading(0.5f).isUsable)
        assertFalse(
            PdfAiAvailability.Unavailable(PdfAiUnavailableReason.DEVICE_NOT_ELIGIBLE).isUsable,
        )
    }

    // MARK: - Resolution order

    @Test
    fun routesAreTriedInOrderAndTheWinnerIsNamed() = runTest {
        val calls = mutableListOf<String>()
        val outcome = resolveRoutes(
            onDevice = { calls += "onDevice"; null },
            customProvider = { calls += "provider"; "from-provider" },
            rules = { calls += "rules"; "from-rules" },
        )

        assertEquals(
            "the rules fallback must not run once a provider answered",
            listOf("onDevice", "provider"), calls,
        )
        assertEquals(
            PdfAiOutcome.Answered(PdfAiResult("from-provider", PdfAiSource.CUSTOM_PROVIDER)),
            outcome,
        )
    }

    @Test
    fun everyRouteEmptyIsUnavailableNotAThrow() = runTest {
        val outcome = resolveRoutes<String>(
            onDevice = { null }, customProvider = { null }, rules = { null },
        )
        assertEquals(
            PdfAiOutcome.NotAvailable(
                PdfAiAvailability.Unavailable(PdfAiUnavailableReason.NO_PROVIDER),
            ),
            outcome,
        )
    }

    /**
     * On a real phone ML Kit threw on every call while reporting itself available, and the
     * caller was told to configure a provider. A failure is not a missing configuration.
     */
    @Test
    fun whenARouteThrowsAndNothingAnswersTheReasonIsRequestFailed() = runTest {
        val outcome = resolveRoutes<String>(
            onDevice = { throw IllegalStateException("AICore error 30") }, customProvider = { null },
        )
        assertEquals(
            PdfAiOutcome.NotAvailable(PdfAiAvailability.Unavailable(PdfAiUnavailableReason.REQUEST_FAILED)),
            outcome,
        )
    }

    /**
     * AICore refuses inference from a background app. Saying so tells the host what to do:
     * call again from the foreground, rather than configure something.
     */
    @Test
    fun aRouteThatFailsForANamedReasonReportsThatReasonWhenNothingAnswers() = runTest {
        val outcome = resolveRoutes<String>(
            onDevice = { throw PdfAiUnavailableException(PdfAiUnavailableReason.BACKGROUND_USE_BLOCKED) },
            customProvider = { throw IllegalStateException("502") },
        )
        assertEquals(
            PdfAiOutcome.NotAvailable(PdfAiAvailability.Unavailable(PdfAiUnavailableReason.BACKGROUND_USE_BLOCKED)),
            outcome,
        )
    }

    @Test
    fun aLaterRouteThatAnswersStillWinsOverANamedFailure() = runTest {
        val outcome = resolveRoutes(
            onDevice = { throw PdfAiUnavailableException(PdfAiUnavailableReason.BACKGROUND_USE_BLOCKED) },
            customProvider = { "from-provider" },
        )
        assertEquals(PdfAiOutcome.Answered(PdfAiResult("from-provider", PdfAiSource.CUSTOM_PROVIDER)), outcome)
    }

    @Test
    fun aRouteThatThrowsDoesNotStopTheNextOne() = runTest {
        val outcome = resolveRoutes(
            onDevice = { null },
            customProvider = { throw IllegalStateException("502") },
            rules = { "from-rules" },
        )
        assertEquals(
            PdfAiOutcome.Answered(PdfAiResult("from-rules", PdfAiSource.RULES)), outcome,
        )
    }

    @Test
    fun onDeviceWinsOutrightWhenItAnswers() = runTest {
        val calls = mutableListOf<String>()
        val outcome = resolveRoutes(
            onDevice = { calls += "onDevice"; "local" },
            customProvider = { calls += "provider"; "remote" },
        )
        // PRV-2's order exists so document content stays on the device when it can.
        assertEquals(listOf("onDevice"), calls)
        assertEquals(PdfAiOutcome.Answered(PdfAiResult("local", PdfAiSource.ON_DEVICE)), outcome)
    }

    // MARK: - Proposals

    @Test
    fun nothingIsWrittenUntilApplyIsCalled() = runTest {
        val written = mutableListOf<String>()
        val set = PdfProposalSet(
            listOf(
                PdfProposal("p1", PdfProposalKind.FORM_VALUE, "Ada", PdfAiSource.RULES),
                PdfProposal("p2", PdfProposalKind.FORM_VALUE, "Lovelace", PdfAiSource.RULES),
            ),
        ) { written += it.id }

        assertEquals("building the set must not touch the document", emptyList<String>(), written)

        set.apply(accepting = listOf("p1"))
        assertEquals("only the accepted proposal is written", listOf("p1"), written)
    }

    @Test
    fun anUnknownIdIsRefusedAndWritesNothing() = runTest {
        val written = mutableListOf<String>()
        val set = PdfProposalSet(
            listOf(PdfProposal("p1", PdfProposalKind.ALT_TEXT, "a cat", PdfAiSource.ON_DEVICE)),
        ) { written += it.id }

        try {
            set.apply(accepting = listOf("p1", "ghost"))
            throw AssertionError("expected a refusal")
        } catch (e: UnknownProposalException) {
            assertTrue(e.message!!.contains("ghost"))
        }
        assertEquals(
            "a set with one bad id must leave the document untouched",
            emptyList<String>(), written,
        )
    }

    @Test
    fun proposalsAreWrittenInProposalOrderNotAcceptanceOrder() = runTest {
        val written = mutableListOf<String>()
        val set = PdfProposalSet(
            listOf(
                PdfProposal("a", PdfProposalKind.REDACTION, "x", PdfAiSource.RULES),
                PdfProposal("b", PdfProposalKind.REDACTION, "y", PdfAiSource.RULES),
            ),
        ) { written += it.id }

        set.apply(accepting = listOf("b", "a"))
        assertEquals(listOf("a", "b"), written)
    }
}
