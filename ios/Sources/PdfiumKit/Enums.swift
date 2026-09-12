/// Page rotation, in 90-degree steps.
public enum PdfPageRotation: Int, Sendable, CaseIterable {
    case none = 0
    case degrees90 = 1
    case degrees180 = 2
    case degrees270 = 3
}

/// What to include when rendering a page.
public struct PdfRenderOptions: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let annotations = PdfRenderOptions(rawValue: 1 << 0)
    public static let forms       = PdfRenderOptions(rawValue: 1 << 1)
    public static let grayscale   = PdfRenderOptions(rawValue: 1 << 2)
    /// Render without anti-aliasing text; useful for pixel-exact comparisons.
    public static let noTextSmoothing = PdfRenderOptions(rawValue: 1 << 3)

    public static let `default`: PdfRenderOptions = [.annotations, .forms]
}

/// Annotation flags, as defined by the PDF specification.
public struct PdfAnnotationFlags: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let invisible = PdfAnnotationFlags(rawValue: 1 << 0)
    public static let hidden    = PdfAnnotationFlags(rawValue: 1 << 1)
    public static let print     = PdfAnnotationFlags(rawValue: 1 << 2)
    public static let noZoom    = PdfAnnotationFlags(rawValue: 1 << 3)
    public static let noRotate  = PdfAnnotationFlags(rawValue: 1 << 4)
    public static let noView    = PdfAnnotationFlags(rawValue: 1 << 5)
    public static let readOnly  = PdfAnnotationFlags(rawValue: 1 << 6)
    public static let locked    = PdfAnnotationFlags(rawValue: 1 << 7)
}

/// Form field flags, as defined by the PDF specification.
public struct PdfFormFieldFlags: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let readOnly = PdfFormFieldFlags(rawValue: 1 << 0)
    public static let required = PdfFormFieldFlags(rawValue: 1 << 1)
    public static let noExport = PdfFormFieldFlags(rawValue: 1 << 2)
    public static let multiline = PdfFormFieldFlags(rawValue: 1 << 12)
    public static let password  = PdfFormFieldFlags(rawValue: 1 << 13)
}

/// Which appearance stream to read or write.
public enum PdfAppearanceMode: Int32, Sendable {
    case normal = 0
    case rollover = 1
    case down = 2
}

/// Permissions granted by the document's security handler.
public struct PdfPermissions: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let print            = PdfPermissions(rawValue: 1 << 2)
    public static let modify           = PdfPermissions(rawValue: 1 << 3)
    public static let copy             = PdfPermissions(rawValue: 1 << 4)
    public static let annotate         = PdfPermissions(rawValue: 1 << 5)
    public static let fillForms        = PdfPermissions(rawValue: 1 << 8)
    public static let extractForAccessibility = PdfPermissions(rawValue: 1 << 9)
    public static let assemble         = PdfPermissions(rawValue: 1 << 10)
    public static let printHighQuality = PdfPermissions(rawValue: 1 << 11)
}

/// Options for text search.
public struct PdfSearchOptions: OptionSet, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let caseSensitive = PdfSearchOptions(rawValue: 1 << 0)
    public static let wholeWord     = PdfSearchOptions(rawValue: 1 << 1)

    public static let none: PdfSearchOptions = []
}
