import XCTest
import CoreGraphics
@testable import PDFCora

/// PDF space is bottom-left origin, view space is top-left. Getting that flip wrong is
/// the most common bug in PDF integration work, so it is tested rather than eyeballed.
final class PdfViewTransformTests: LicensedTestCase {
    private let page = PdfSize(width: 200, height: 400)

    func testTopLeftOfThePageIsTheOriginInViewSpace() {
        let t = PdfViewTransform(page: page, scale: 1)
        let topLeft = PdfPoint(x: 0, y: 400)      // PDF: y grows upward
        let point = t.toView(topLeft)
        XCTAssertEqual(point.x, 0, accuracy: 0.001)
        XCTAssertEqual(point.y, 0, accuracy: 0.001)
    }

    func testBottomLeftOfThePageIsTheBottomInViewSpace() {
        let t = PdfViewTransform(page: page, scale: 1)
        let point = t.toView(PdfPoint(x: 0, y: 0))
        XCTAssertEqual(point.y, 400, accuracy: 0.001)
    }

    func testScaleAppliesToBothAxes() {
        let t = PdfViewTransform(page: page, scale: 2)
        let point = t.toView(PdfPoint(x: 10, y: 400))
        XCTAssertEqual(point.x, 20, accuracy: 0.001)
        XCTAssertEqual(point.y, 0, accuracy: 0.001)
        XCTAssertEqual(t.viewSize.width, 400, accuracy: 0.001)
        XCTAssertEqual(t.viewSize.height, 800, accuracy: 0.001)
    }

    func testPointRoundTrips() {
        let t = PdfViewTransform(page: page, scale: 1.75)
        for original in [PdfPoint(x: 0, y: 0), PdfPoint(x: 37.5, y: 291.25), PdfPoint(x: 200, y: 400)] {
            let round = t.toPdf(t.toView(original))
            XCTAssertEqual(round.x, original.x, accuracy: 0.0001, "x for \(original)")
            XCTAssertEqual(round.y, original.y, accuracy: 0.0001, "y for \(original)")
        }
    }

    func testRectRoundTripsAndKeepsItsSize() {
        let t = PdfViewTransform(page: page, scale: 2)
        let original = PdfRect(left: 10, bottom: 20, right: 60, top: 120)

        let view = t.toView(original)
        XCTAssertEqual(view.width, 100, accuracy: 0.001)
        XCTAssertEqual(view.height, 200, accuracy: 0.001)
        // Top of the rect in PDF space is nearer the top of the view.
        XCTAssertEqual(view.minY, (400 - 120) * 2, accuracy: 0.001)

        let round = t.toPdf(view)
        XCTAssertEqual(round.left, original.left, accuracy: 0.0001)
        XCTAssertEqual(round.bottom, original.bottom, accuracy: 0.0001)
        XCTAssertEqual(round.right, original.right, accuracy: 0.0001)
        XCTAssertEqual(round.top, original.top, accuracy: 0.0001)
    }

    func testFittingWidthDerivesTheScale() {
        let t = PdfViewTransform(page: page, fittingWidth: 600)
        XCTAssertEqual(t.scale, 3, accuracy: 0.0001)
        XCTAssertEqual(t.viewSize.height, 1200, accuracy: 0.001)
    }

    func testZeroSizedPageDoesNotProduceNaN() {
        let t = PdfViewTransform(page: PdfSize(width: 0, height: 0), fittingWidth: 100)
        XCTAssertTrue(t.scale.isFinite, "scale must stay finite for a degenerate page")
    }
}

final class PdfRectHitTestingTests: LicensedTestCase {
    private let rect = PdfRect(left: 10, bottom: 20, right: 60, top: 120)

    func testContainsAPointInside() {
        XCTAssertTrue(rect.contains(PdfPoint(x: 35, y: 70)))
    }

    func testContainsIsInclusiveOnEdges() {
        XCTAssertTrue(rect.contains(PdfPoint(x: 10, y: 20)))
        XCTAssertTrue(rect.contains(PdfPoint(x: 60, y: 120)))
    }

    func testRejectsPointsOutside() {
        XCTAssertFalse(rect.contains(PdfPoint(x: 9, y: 70)))
        XCTAssertFalse(rect.contains(PdfPoint(x: 35, y: 121)))
    }

    /// PDFium hands back rects with edges in either order, so containment must not
    /// assume left < right or bottom < top.
    func testHandlesInvertedEdges() {
        let flipped = PdfRect(left: 60, bottom: 120, right: 10, top: 20)
        XCTAssertTrue(flipped.contains(PdfPoint(x: 35, y: 70)))
    }
}
