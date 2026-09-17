import SwiftUI
import PDFCora

/// How the viewer looks.
///
/// Tokens are the tested path and mean the same thing on every platform. Each platform
/// also accepts its own styling, which is deliberately **outside** the conformance
/// contract: once used, cross-platform parity is the app's to maintain.
public struct PdfViewerTheme: Equatable, Sendable {
    public var accent: Color
    public var background: Color
    public var pageBackground: Color
    public var pageShadow: Color
    public var toolbarBackground: Color
    public var toolbarForeground: Color
    public var selectionStroke: Color
    public var redactionFill: Color
    public var cornerRadius: Double
    public var iconSize: Double
    public var toolbarHeight: Double

    public init(accent: Color = .accentColor,
                background: Color = Color(.systemBackground),
                pageBackground: Color = .white,
                pageShadow: Color = Color.black.opacity(0.18),
                toolbarBackground: Color = Color(.secondarySystemBackground),
                toolbarForeground: Color = .primary,
                selectionStroke: Color = .orange,
                redactionFill: Color = Color.black.opacity(0.72),
                cornerRadius: Double = 7,
                iconSize: Double = 17,
                toolbarHeight: Double = 44) {
        self.accent = accent
        self.background = background
        self.pageBackground = pageBackground
        self.pageShadow = pageShadow
        self.toolbarBackground = toolbarBackground
        self.toolbarForeground = toolbarForeground
        self.selectionStroke = selectionStroke
        self.redactionFill = redactionFill
        self.cornerRadius = cornerRadius
        self.iconSize = iconSize
        self.toolbarHeight = toolbarHeight
    }

    public static let light = PdfViewerTheme()
    public static let dark = PdfViewerTheme(pageBackground: Color(white: 0.92),
                                            pageShadow: .black)
}
