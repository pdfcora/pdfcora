package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors the iOS PdfViewTransformTests, so both SDKs meet the same contract. */
@RunWith(AndroidJUnit4::class)
class GeometryTest {
    private val page = PdfSize(200f, 400f)

    @Test fun topLeftOfPageIsOriginInViewSpace() {
        val p = PdfViewTransform(page, 1f).toView(PdfPoint(0f, 400f))
        assertEquals(0f, p.x, 0.001f)
        assertEquals(0f, p.y, 0.001f)
    }

    @Test fun bottomLeftOfPageIsBottomInViewSpace() {
        assertEquals(400f, PdfViewTransform(page, 1f).toView(PdfPoint(0f, 0f)).y, 0.001f)
    }

    @Test fun scaleAppliesToBothAxes() {
        val t = PdfViewTransform(page, 2f)
        val p = t.toView(PdfPoint(10f, 400f))
        assertEquals(20f, p.x, 0.001f)
        assertEquals(0f, p.y, 0.001f)
        assertEquals(400f, t.viewWidth, 0.001f)
        assertEquals(800f, t.viewHeight, 0.001f)
    }

    @Test fun pointsRoundTrip() {
        val t = PdfViewTransform(page, 1.75f)
        for (original in listOf(PdfPoint(0f, 0f), PdfPoint(37.5f, 291.25f), PdfPoint(200f, 400f))) {
            val v = t.toView(original)
            val round = t.toPdf(v.x, v.y)
            assertEquals("x for $original", original.x, round.x, 0.001f)
            assertEquals("y for $original", original.y, round.y, 0.001f)
        }
    }

    @Test fun rectsRoundTripAndKeepTheirSize() {
        val t = PdfViewTransform(page, 2f)
        val original = PdfRect(10f, 20f, 60f, 120f)
        val view = t.toView(original)
        assertEquals(100f, view.width(), 0.001f)
        assertEquals(200f, view.height(), 0.001f)
        assertEquals((400f - 120f) * 2f, view.top, 0.001f)

        val round = t.toPdf(view)
        assertEquals(original.left, round.left, 0.001f)
        assertEquals(original.bottom, round.bottom, 0.001f)
        assertEquals(original.right, round.right, 0.001f)
        assertEquals(original.top, round.top, 0.001f)
    }

    @Test fun fittingWidthDerivesTheScale() {
        val t = PdfViewTransform.fittingWidth(page, 600f)
        assertEquals(3f, t.scale, 0.001f)
        assertEquals(1200f, t.viewHeight, 0.001f)
    }

    @Test fun zeroSizedPageKeepsScaleFinite() {
        val t = PdfViewTransform.fittingWidth(PdfSize(0f, 0f), 100f)
        assertTrue(t.scale.isFinite())
    }

    @Test fun rectContainsIsInclusiveAndOrderAgnostic() {
        val rect = PdfRect(10f, 20f, 60f, 120f)
        assertTrue(rect.contains(PdfPoint(35f, 70f)))
        assertTrue(rect.contains(PdfPoint(10f, 20f)))
        assertTrue(rect.contains(PdfPoint(60f, 120f)))
        assertFalse(rect.contains(PdfPoint(9f, 70f)))
        assertFalse(rect.contains(PdfPoint(35f, 121f)))
        assertTrue(PdfRect(60f, 120f, 10f, 20f).contains(PdfPoint(35f, 70f)))
    }
}
