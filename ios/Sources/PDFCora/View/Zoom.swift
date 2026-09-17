import Foundation

public enum PdfZoomMode: String, Equatable, Sendable, Codable {
    case fitWidth, fitPage, free
}

/// How magnified the page is, and how that was arrived at.
///
/// A type rather than a number because three consumers need different things from it:
/// rendering needs the absolute ``scale``, sync needs the ``mode`` — a peer receiving
/// ``PdfZoomMode/fitWidth`` fits *its own* window, while ``PdfZoomMode/free`` it adopts
/// literally — and a toolbar needs a percentage, which is derived rather than stored so
/// it cannot go stale when the window resizes.
public struct PdfZoom: Equatable, Sendable, Codable {
    /// View points per PDF point. 1.0 is 1:1.
    public let scale: Double
    public let mode: PdfZoomMode

    public init(scale: Double, mode: PdfZoomMode) {
        self.scale = scale
        self.mode = mode
    }

    public static let steps: [Double] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

    /// A degenerate page would give an infinite or NaN scale, poisoning every coordinate
    /// derived from it, so it falls back to 1:1.
    private static func safeRatio(_ available: Double, _ page: Double) -> Double {
        page > 0 ? available / page : 1
    }

    public static func fitting(width: Double, page: PdfSize) -> PdfZoom {
        PdfZoom(scale: safeRatio(width, page.width), mode: .fitWidth)
    }

    public static func fitting(size: CGSize, page: PdfSize) -> PdfZoom {
        // Whichever dimension runs out first decides; otherwise the page overflows the other.
        PdfZoom(scale: min(safeRatio(size.width, page.width), safeRatio(size.height, page.height)),
                mode: .fitPage)
    }

    /// 1:1 based, as Acrobat and Preview mean it. A phone's normal view reads about 64%.
    public var percentage: Int { Int((scale * 100).rounded()) }

    /// Fit based, as most viewers mean it: 100% is whatever fills the window.
    public func percentage(ofFit fitScale: Double) -> Int {
        fitScale > 0 ? Int(((scale / fitScale) * 100).rounded()) : 100
    }

    /// Moves one rung along the ladder.
    ///
    /// A fit scale is almost never exactly on a rung, so stepping goes to the first rung
    /// strictly beyond the current scale. The result is always ``PdfZoomMode/free``: the
    /// user picked this number, so a peer adopts it rather than re-deriving its own fit.
    public func stepped(_ direction: Int) -> PdfZoom {
        let next = direction > 0
            ? (Self.steps.first { $0 > scale + 1e-9 } ?? Self.steps[Self.steps.count - 1])
            : (Self.steps.last { $0 < scale - 1e-9 } ?? Self.steps[0])
        return PdfZoom(scale: next, mode: .free)
    }
}
