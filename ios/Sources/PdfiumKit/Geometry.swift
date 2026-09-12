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
