import CoreGraphics
import UIKit

/// A point in PDF page space: origin bottom-left, units are points (1/72 inch).
public struct PdfPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// A rectangle in PDF page space: origin bottom-left, units are points.
///
/// Converting to view space is always explicit — see ``converted(to:)``. There is no
/// implicit Y-flip anywhere in this SDK.
public struct PdfRect: Equatable, Sendable {
    public var left: Double
    public var bottom: Double
    public var right: Double
    public var top: Double

    public init(left: Double, bottom: Double, right: Double, top: Double) {
        self.left = left; self.bottom = bottom; self.right = right; self.top = top
    }

    public var width: Double { right - left }
    public var height: Double { top - bottom }

    /// The target space for ``PdfRect/converted(to:)``.
    public struct ViewSpace: Sendable {
        let pageHeight: Double
        let scale: Double
        /// View space for a page of `pageHeight` points, rendered at `scale` pixels per point.
        public static func page(height pageHeight: Double, scale: Double = 1) -> ViewSpace {
            ViewSpace(pageHeight: pageHeight, scale: scale)
        }
    }

    /// Converts to top-left-origin view coordinates.
    public func converted(to space: ViewSpace) -> CGRect {
        CGRect(
            x: left * space.scale,
            y: (space.pageHeight - top) * space.scale,
            width: width * space.scale,
            height: height * space.scale
        )
    }
}

/// Four corner points, as used by text-markup annotations.
public struct PdfQuad: Equatable, Sendable {
    public var p1: PdfPoint
    public var p2: PdfPoint
    public var p3: PdfPoint
    public var p4: PdfPoint
    public init(p1: PdfPoint, p2: PdfPoint, p3: PdfPoint, p4: PdfPoint) {
        self.p1 = p1; self.p2 = p2; self.p3 = p3; self.p4 = p4
    }
}

/// An RGBA colour.
public struct PdfColor: Equatable, Sendable {
    public var red: UInt8
    public var green: UInt8
    public var blue: UInt8
    public var alpha: UInt8

    public init(red: UInt8, green: UInt8, blue: UInt8, alpha: UInt8 = 255) {
        self.red = red; self.green = green; self.blue = blue; self.alpha = alpha
    }

    public init(_ color: UIColor) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        func byte(_ v: CGFloat) -> UInt8 { UInt8(max(0, min(255, (v * 255).rounded()))) }
        self.init(red: byte(r), green: byte(g), blue: byte(b), alpha: byte(a))
    }

    public var uiColor: UIColor {
        UIColor(red: CGFloat(red) / 255, green: CGFloat(green) / 255,
                blue: CGFloat(blue) / 255, alpha: CGFloat(alpha) / 255)
    }

    public static let black = PdfColor(red: 0, green: 0, blue: 0)
    public static let yellow = PdfColor(red: 255, green: 255, blue: 0, alpha: 128)
}

/// Converts between PDF page space (bottom-left origin) and view space (top-left).
///
/// Anything interactive needs both directions: PDF to view to draw an overlay, view to
/// PDF to work out what a tap landed on. Doing the Y-flip by hand at each call site is
/// where this goes wrong, so it lives here.
///
/// ```swift
/// let transform = PdfViewTransform(page: try await page.size, fittingWidth: canvasWidth)
/// let box = transform.toView(annotation.rect)          // draw it
/// let tapped = transform.toPdf(gesture.location)       // hit-test it
/// ```
public struct PdfViewTransform: Equatable, Sendable {
    public let pageSize: PdfSize
    /// View points per PDF point.
    public let scale: Double

    public init(page pageSize: PdfSize, scale: Double) {
        self.pageSize = pageSize
        self.scale = scale
    }

    /// Derives the scale needed to fit the page into `width` view points.
    public init(page pageSize: PdfSize, fittingWidth width: Double) {
        // A degenerate page would otherwise produce an infinite or NaN scale, which
        // silently poisons every later coordinate.
        self.init(page: pageSize, scale: pageSize.width > 0 ? width / pageSize.width : 1)
    }

    /// Size of the whole page in view points.
    public var viewSize: CGSize {
        CGSize(width: pageSize.width * scale, height: pageSize.height * scale)
    }

    public func toView(_ point: PdfPoint) -> CGPoint {
        CGPoint(x: point.x * scale, y: (pageSize.height - point.y) * scale)
    }

    public func toView(_ rect: PdfRect) -> CGRect {
        let topLeft = toView(PdfPoint(x: min(rect.left, rect.right), y: max(rect.bottom, rect.top)))
        return CGRect(x: topLeft.x, y: topLeft.y,
                      width: abs(rect.right - rect.left) * scale,
                      height: abs(rect.top - rect.bottom) * scale)
    }

    public func toPdf(_ point: CGPoint) -> PdfPoint {
        PdfPoint(x: Double(point.x) / scale, y: pageSize.height - Double(point.y) / scale)
    }

    public func toPdf(_ rect: CGRect) -> PdfRect {
        let topLeft = toPdf(CGPoint(x: rect.minX, y: rect.minY))
        let bottomRight = toPdf(CGPoint(x: rect.maxX, y: rect.maxY))
        return PdfRect(left: topLeft.x, bottom: bottomRight.y, right: bottomRight.x, top: topLeft.y)
    }

    /// The PDF point currently at the centre of the viewport.
    ///
    /// This is the transferable form of a scroll position: an offset is in this viewer's
    /// own points, relative to its own content size, and means nothing on another screen.
    public func center(forScrollOffset offset: CGPoint, in viewport: CGSize) -> PdfPoint {
        toPdf(CGPoint(x: offset.x + viewport.width / 2, y: offset.y + viewport.height / 2))
    }

    /// Where to scroll so `center` sits in the middle of the viewport.
    ///
    /// Clamped to the scrollable range, so a centre near a page edge gives a valid offset
    /// on a differently shaped screen rather than one outside the content. A viewport
    /// larger than the page scrolls to zero and the app centres it.
    public func scrollOffset(centering center: PdfPoint, in viewport: CGSize) -> CGPoint {
        let view = toView(center)
        let content = viewSize
        func clamp(_ value: CGFloat, _ maximum: CGFloat) -> CGFloat {
            max(0, min(value, max(0, maximum)))
        }
        return CGPoint(x: clamp(view.x - viewport.width / 2, content.width - viewport.width),
                       y: clamp(view.y - viewport.height / 2, content.height - viewport.height))
    }
}

extension PdfRect {
    /// Whether `point` falls inside, edges included.
    ///
    /// Edge order is normalised first: PDFium returns rects with `left > right` or
    /// `bottom > top` often enough that assuming otherwise misses real hits.
    public func contains(_ point: PdfPoint) -> Bool {
        point.x >= min(left, right) && point.x <= max(left, right)
            && point.y >= min(bottom, top) && point.y <= max(bottom, top)
    }
}
