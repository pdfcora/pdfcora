package com.pdfcora.view

import com.pdfcora.PdfColor
import com.pdfcora.PdfPageRotation
import com.pdfcora.PdfQuad
import com.pdfcora.PdfRedactionTarget
import com.pdfcora.PdfPoint
import com.pdfcora.PdfRect
import com.pdfcora.PdfSize
import com.pdfcora.PdfViewTransform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mirrors the web `test/{zoom,scroll-roundtrip,view-state,view-codec}.test.ts` suites and
 * the iOS ViewerTests.
 *
 * If a test here needs different assertions than its twin, the implementations have
 * diverged and one of them is wrong.
 */
class ViewModelTest {

    private val letter = PdfSize(612f, 792f)
    private val phone = PdfViewport(390f, 700f)
    private val desktop = PdfViewport(1200f, 800f)

    // MARK: - Zoom

    @Test
    fun fitWidthDerivesTheScaleThatFillsTheWidth() {
        val zoom = PdfZoom.fittingWidth(390f, letter)
        assertEquals(PdfZoomMode.FIT_WIDTH, zoom.mode)
        assertEquals(390f / 612f, zoom.scale, 1e-6f)
    }

    @Test
    fun theTwoPercentageHelpersAnswerDifferentQuestions() {
        val phoneFit = PdfZoom.fittingWidth(390f, letter)
        assertEquals(64, phoneFit.percentage)
        assertEquals(100, phoneFit.percentageOfFit(phoneFit.scale))

        val wideFit = PdfZoom.fittingWidth(1200f, letter)
        assertEquals(196, wideFit.percentage)
        assertEquals(100, wideFit.percentageOfFit(wideFit.scale))
    }

    @Test
    fun aDegeneratePageCannotProduceANonFiniteScale() {
        assertEquals(1f, PdfZoom.fittingWidth(390f, PdfSize(0f, 792f)).scale, 0f)
        assertEquals(1f, PdfZoom.fittingSize(phone, PdfSize(0f, 0f)).scale, 0f)
    }

    @Test
    fun steppingMovesThroughTheLadderAndClamps() {
        assertEquals(1.25f, PdfZoom(1f, PdfZoomMode.FREE).stepped(1).scale, 0f)
        assertEquals(0.75f, PdfZoom(1f, PdfZoomMode.FREE).stepped(-1).scale, 0f)
        assertEquals(4f, PdfZoom(4f, PdfZoomMode.FREE).stepped(1).scale, 0f)
        assertEquals(0.25f, PdfZoom(0.25f, PdfZoomMode.FREE).stepped(-1).scale, 0f)
        // A fit scale is almost never exactly on a rung.
        assertEquals(0.75f, PdfZoom(0.64f, PdfZoomMode.FIT_WIDTH).stepped(1).scale, 0f)
        assertEquals(PdfZoomMode.FREE, PdfZoom.fittingWidth(390f, letter).stepped(1).mode)
    }

    // MARK: - Scroll

    @Test
    fun offsetToCentreToOffsetLandsWhereItStarted() {
        for (page in listOf(letter, PdfSize(200f, 1000f))) {
            for (scale in listOf(0.25f, 0.64f, 1f, 1.96f, 4f)) {
                for (viewport in listOf(phone, desktop)) {
                    val t = PdfViewTransform(page, scale)
                    val maxX = maxOf(0f, t.viewWidth - viewport.width)
                    val maxY = maxOf(0f, t.viewHeight - viewport.height)

                    for (offset in listOf(
                        PdfViewOffset(0f, 0f), PdfViewOffset(maxX, maxY),
                        PdfViewOffset(maxX / 2f, maxY / 2f),
                    )) {
                        val centre = t.centerForScrollOffset(offset, viewport)
                        val back = t.scrollOffsetCentering(centre, viewport)
                        assertEquals(offset.x, back.x, 0.5f)
                        assertEquals(offset.y, back.y, 0.5f)
                    }
                }
            }
        }
    }

    @Test
    fun aKnownOffsetMapsToAHandComputedCentreAndBack() {
        // Round trips alone cannot catch a symmetric error: both directions sharing the
        // same mistake still invert each other. Mutation-testing the web suite proved it.
        //
        //   page 612x792 at scale 1, viewport 400x600, offset (100, 50)
        //   view centre = (300, 350); toPdf = (300, 792 - 350) = (300, 442)
        val t = PdfViewTransform(letter, 1f)
        val viewport = PdfViewport(400f, 600f)

        val centre = t.centerForScrollOffset(PdfViewOffset(100f, 50f), viewport)
        assertEquals(300f, centre.x, 1e-4f)
        assertEquals(442f, centre.y, 1e-4f)

        val offset = t.scrollOffsetCentering(PdfPoint(300f, 442f), viewport)
        assertEquals(100f, offset.x, 1e-4f)
        assertEquals(50f, offset.y, 1e-4f)
    }

    @Test
    fun aPageThatFitsEntirelyIsCentred() {
        // Not a defect: with nothing to scroll, the middle of the window is the middle
        // of the page. A peer showing the whole page cannot reproduce an off-centre view.
        val t = PdfViewTransform(letter, 1.96f)
        val viewport = PdfViewport(1200f, 2000f)
        val offset = t.scrollOffsetCentering(PdfPoint(100f, 400f), viewport)
        assertEquals(0f, offset.x, 0f)
        assertEquals(letter.width / 2f, t.centerForScrollOffset(offset, viewport).x, 1f)
    }

    // MARK: - Current page

    @Test
    fun theCurrentPageIsTheOneContainingTheCentre() {
        val heights = List(50) { 100f }
        assertEquals(20, pdfCurrentPage(heights, 2250f, 10f))
        assertEquals(22, pdfCurrentPage(heights, 2250f, 0f))
        assertEquals(49, pdfCurrentPage(heights, 99999f, 0f))
        assertEquals(0, pdfCurrentPage(emptyList(), 50f, 0f))
    }

    // MARK: - Codec

    @Test(expected = PdfViewCodecException::class)
    fun anUnknownVersionIsRefusedRatherThanMisread() {
        PdfViewCodec.decode("""{"v":999,"sequence":1}""")
    }

    @Test
    fun rotationTravelsAsDegreesNotAsAQuarterTurnIndex() {
        // Android holds rotation as PDFium's index 0..3; the wire carries degrees. A
        // platform writing the index would send 1 where a peer expects 90.
        assertEquals(90, PdfViewCodec.degrees(PdfPageRotation.DEGREES_90))
        assertEquals(PdfPageRotation.DEGREES_90, PdfViewCodec.rotationFromDegrees(90))
        assertEquals(PdfPageRotation.DEGREES_270, PdfViewCodec.rotationFromDegrees(270))

        val event = PdfViewEvent(
            1, "a", PdfViewEventOrigin.LOCAL,
            PdfViewChange.Viewport(PdfViewState(
                0, PdfPoint(1f, 2f), PdfZoom(1f, PdfZoomMode.FREE),
                PdfPageRotation.DEGREES_90, PdfPageLayout.CONTINUOUS,
            )),
        )
        assertTrue(PdfViewCodec.encode(event).contains("\"rotation\":90"))
    }

    @Test
    fun anEventSurvivesARoundTrip() {
        val event = PdfViewEvent(
            7, "abc", PdfViewEventOrigin.LOCAL,
            PdfViewChange.Viewport(PdfViewState(
                3, PdfPoint(306f, 400f), PdfZoom(1.5f, PdfZoomMode.FREE),
                PdfPageRotation.DEGREES_180, PdfPageLayout.CONTINUOUS,
            )),
        )
        assertEquals(event, PdfViewCodec.decode(PdfViewCodec.encode(event)))
    }

    @Test
    fun aSelectionSurvivesARoundTrip() {
        for (selection in listOf(
            PdfSelection.Region(1, PdfRect(1f, 2f, 3f, 4f)),
            PdfSelection.Annotation(2, 5),
        )) {
            val event = PdfViewEvent(1, "a", PdfViewEventOrigin.LOCAL,
                                     PdfViewChange.Selection(selection))
            assertEquals(event, PdfViewCodec.decode(PdfViewCodec.encode(event)))
        }
    }

    // MARK: - The cross-platform contract

    @Test
    fun everyFixtureCaseDerivesTheOffsetsItClaims() {
        // conformance/view-state.json is the file the web and iOS suites read too. Its
        // expected values were computed by independent arithmetic rather than by running
        // any SDK, so agreement is evidence rather than three copies of one mistake.
        val fixture = org.json.JSONObject(fixtureFile().readText())
        val cases = fixture.getJSONArray("cases")
        assertTrue("the fixture must carry real cases", cases.length() >= 5)

        for (i in 0 until cases.length()) {
            val testCase = cases.getJSONObject(i)
            val name = testCase.getString("name")
            val pageRaw = testCase.getJSONObject("page")
            val page = PdfSize(
                pageRaw.getDouble("width").toFloat(),
                pageRaw.getDouble("height").toFloat(),
            )

            val event = PdfViewCodec.decode(testCase.getJSONObject("wire").toString())
            val state = (event.change as PdfViewChange.Viewport).state

            if (testCase.has("expectRotationDegrees")) {
                assertEquals(
                    "$name: rotation must cross the wire as degrees",
                    testCase.getInt("expectRotationDegrees"),
                    PdfViewCodec.degrees(state.rotation),
                )
            }

            val receivers = testCase.getJSONArray("receivers")
            for (j in 0 until receivers.length()) {
                val receiver = receivers.getJSONObject(j)
                val v = receiver.getJSONObject("viewport")
                val viewport = PdfViewport(
                    v.getDouble("width").toFloat(), v.getDouble("height").toFloat(),
                )

                // A fit is re-derived for this receiver's window; a free zoom is adopted.
                val zoom = when (state.zoom.mode) {
                    PdfZoomMode.FREE -> state.zoom
                    PdfZoomMode.FIT_WIDTH -> PdfZoom.fittingWidth(viewport.width, page)
                    PdfZoomMode.FIT_PAGE -> PdfZoom.fittingSize(viewport, page)
                }
                assertEquals("$name: scale",
                             receiver.getDouble("expectScale").toFloat(), zoom.scale, 1e-4f)

                val offset = PdfViewTransform(page, zoom.scale)
                    .scrollOffsetCentering(state.center, viewport)
                val expected = receiver.getJSONObject("expectScrollOffset")
                assertEquals("$name @${viewport.width.toInt()}: x",
                             expected.getDouble("x").toFloat(), offset.x, 0.5f)
                assertEquals("$name @${viewport.width.toInt()}: y",
                             expected.getDouble("y").toFloat(), offset.y, 0.5f)
            }
        }
    }

    /** The edit half of the contract: the same file the web and iOS suites read. */
    @Test
    fun everyFixtureEditCaseDecodesToTheExpectedArguments() {
        val fixture = org.json.JSONObject(fixtureFile().readText())
        val cases = fixture.getJSONArray("editCases")
        assertTrue(cases.length() >= 5)

        for (i in 0 until cases.length()) {
            val testCase = cases.getJSONObject(i)
            val name = testCase.getString("name")
            val wire = testCase.getJSONObject("wire")
            val event = PdfViewCodec.decode(wire.toString())
            val edit = (event.change as PdfViewChange.Edit).edit
            val expect = testCase.getJSONObject("expect")

            assertEquals("$name: the fingerprint must survive decoding",
                         wire.getString("documentFingerprint"), event.documentFingerprint)

            when (val kind = expect.getString("kind")) {
                "noteAdded" -> {
                    val note = edit as PdfEdit.NoteAdded
                    assertEquals(name, expect.getInt("page"), note.page)
                    assertEquals(name, expect.getString("contents"), note.contents)
                    val r = expect.getJSONObject("rect")
                    assertEquals(name, r.getDouble("left").toFloat(), note.rect.left, 1e-4f)
                    assertEquals(name, r.getDouble("top").toFloat(), note.rect.top, 1e-4f)
                }
                "inkAdded" -> {
                    val ink = edit as PdfEdit.InkAdded
                    assertEquals(name, expect.getInt("page"), ink.page)
                    val counts = expect.getJSONArray("strokePointCounts")
                    assertEquals(name, (0 until counts.length()).map { counts.getInt(it) }, ink.strokes.map { it.size })
                    assertEquals(name, expect.getDouble("lineWidth").toFloat(), ink.lineWidth, 1e-4f)
                }
                "annotationRemoved" -> {
                    val removed = edit as PdfEdit.AnnotationRemoved
                    assertEquals(name, expect.getInt("page"), removed.page)
                    assertEquals(name, expect.getInt("index"), removed.index)
                }
                "fieldTextSet" -> {
                    val field = edit as PdfEdit.FieldTextSet
                    assertEquals(name, expect.getInt("annotationIndex"), field.annotationIndex)
                    assertEquals(name, expect.getString("value"), field.value)
                }
                "redacted" -> {
                    val redacted = edit as PdfEdit.Redacted
                    assertEquals(name, expect.getInt("targetCount"), redacted.targets.size)
                    assertTrue(name, redacted.targets[0] is PdfRedactionTarget.Region)
                    assertEquals(name, expect.getString("secondQuery"),
                                 (redacted.targets[1] as PdfRedactionTarget.TextMatches).query)
                }
                else -> throw AssertionError("$name: unhandled kind $kind")
            }
        }
    }

    /** Walks up from the module directory, so the test does not depend on where Gradle
     *  happens to set the working directory. */
    private fun fixtureFile(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "conformance/view-state.json")
            if (candidate.exists()) return candidate
            dir = dir.parentFile
        }
        throw IllegalStateException("conformance/view-state.json not found above ${System.getProperty("user.dir")}")
    }
}

/** The edit event's wire format. Pure logic, so it runs on the JVM. */
class EditCodecTest {

    private val rect = PdfRect(10f, 10f, 30f, 30f)

    @Test
    fun everyEditKindSurvivesARoundTrip() {
        val edits = listOf(
            PdfEdit.NoteAdded(0, rect, "n", PdfColor.YELLOW),
            PdfEdit.InkAdded(1, listOf(listOf(PdfPoint(1f, 2f), PdfPoint(3f, 4f)), listOf(PdfPoint(5f, 6f))), PdfColor.BLACK, 3f),
            PdfEdit.HighlightAdded(2, listOf(PdfQuad(
                PdfPoint(1f, 2f), PdfPoint(3f, 2f), PdfPoint(1f, 1f), PdfPoint(3f, 1f))),
                PdfColor.YELLOW),
            PdfEdit.AnnotationRemoved(3, 4),
            PdfEdit.FieldTextSet(0, 1, "typed"),
            PdfEdit.FieldCheckedSet(0, 2, true),
            PdfEdit.FieldOptionSet(0, 3, 4, true),
            PdfEdit.Redacted(listOf(
                PdfRedactionTarget.Region(rect, 0),
                PdfRedactionTarget.TextMatches("secret"))),
        )
        for (edit in edits) {
            val event = PdfViewEvent(1, "a", PdfViewEventOrigin.LOCAL,
                                     PdfViewChange.Edit(edit), "abc-123")
            assertEquals("$edit did not survive", event, PdfViewCodec.decode(PdfViewCodec.encode(event)))
        }
    }

    @Test
    fun theFingerprintRidesOnEditsOnly() {
        val withEdit = PdfViewEvent(1, "a", PdfViewEventOrigin.LOCAL,
                                    PdfViewChange.Edit(PdfEdit.AnnotationRemoved(0, 0)), "fp-1")
        assertTrue(PdfViewCodec.encode(withEdit).contains("documentFingerprint"))

        val withTool = PdfViewEvent(1, "a", PdfViewEventOrigin.LOCAL, PdfViewChange.Tool(PdfTool.INK))
        assertFalse(PdfViewCodec.encode(withTool).contains("documentFingerprint"))
    }
}
