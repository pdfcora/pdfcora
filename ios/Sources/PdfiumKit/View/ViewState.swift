import Foundation

public enum PdfPageLayout: String, Equatable, Sendable, Codable {
    case single, continuous
}

/// What a drag on the page does. Lives in the SDK so peers can agree on it.
public enum PdfTool: String, Equatable, Sendable, Codable {
    case select, ink, note, highlight, redact
}

/// What the user has picked out: a dragged area, or an existing annotation.
public enum PdfSelection: Equatable, Sendable {
    case region(page: Int, rect: PdfRect)
    case annotation(page: Int, index: Int)
}

/// Where a viewer is looking, in a form that survives a change of screen.
///
/// Held in document space rather than view space: a scroll offset is in the sending
/// viewer's own pixels and means nothing elsewhere, so what travels is the page and the
/// PDF point at the centre of the viewport.
public struct PdfViewState: Equatable, Sendable {
    public let pageIndex: Int
    /// In PDF coordinates on ``pageIndex``: the point at the centre of the viewport.
    public let center: PdfPoint
    public let zoom: PdfZoom
    public let rotation: PdfPageRotation
    public let layout: PdfPageLayout

    public init(pageIndex: Int, center: PdfPoint, zoom: PdfZoom,
                rotation: PdfPageRotation, layout: PdfPageLayout) {
        self.pageIndex = pageIndex
        self.center = center
        self.zoom = zoom
        self.rotation = rotation
        self.layout = layout
    }
}

/// A change to the document, carrying the arguments of the call that made it.
///
/// An event saying only "annotation 3 was added" cannot be reproduced by a peer — it
/// does not say what to add — so each case mirrors the parameters of the API it came
/// from.
///
/// `inkAdded` carries one stroke, not many: this SDK's `addInk` takes several on Apple
/// platforms and one on the others, so a multi-stroke edit has no faithful
/// cross-platform meaning.
public enum PdfEdit: Equatable, Sendable {
    case noteAdded(page: Int, rect: PdfRect, contents: String, color: PdfColor)
    case inkAdded(page: Int, stroke: [PdfPoint], color: PdfColor, lineWidth: Double)
    case highlightAdded(page: Int, quads: [PdfQuad], color: PdfColor)
    case annotationRemoved(page: Int, index: Int)
    case fieldTextSet(page: Int, annotationIndex: Int, value: String)
    case fieldCheckedSet(page: Int, annotationIndex: Int, checked: Bool)
    case fieldOptionSet(page: Int, annotationIndex: Int, option: Int, selected: Bool)
    case redacted(targets: [PdfRedactionTarget])
}

public enum PdfViewChange: Equatable, Sendable {
    case viewport(PdfViewState)
    case selection(PdfSelection?)
    case tool(PdfTool)
    case edit(PdfEdit)
}

public enum PdfViewEventOrigin: String, Equatable, Sendable, Codable {
    case local, remote
}

public struct PdfViewEvent: Equatable, Sendable {
    /// Per sender. A peer ignores anything at or below the highest it has seen.
    public let sequence: Int
    /// Set on edit events: a hash of the bytes the sender opened. A peer refuses an edit
    /// whose fingerprint does not match its own, since indices are positions in bytes.
    public let documentFingerprint: String?
    public let sessionId: String
    /// Applying a remote event must emit nothing, or two viewers echo each other.
    public let origin: PdfViewEventOrigin
    public let change: PdfViewChange

    public init(sequence: Int, sessionId: String,
                origin: PdfViewEventOrigin, change: PdfViewChange,
                documentFingerprint: String? = nil) {
        self.sequence = sequence
        self.documentFingerprint = documentFingerprint
        self.sessionId = sessionId
        self.origin = origin
        self.change = change
    }
}

/// Which page the centre falls on, walking the stack of page heights.
///
/// `gap` is the spacing the app draws between pages. It counts: ignoring it is two pages
/// out by page twenty of a fifty-page document.
public func pdfCurrentPage(heights: [Double], centerY: Double, gap: Double) -> Int {
    var bottom = 0.0
    for (index, height) in heights.enumerated() {
        bottom += height + gap
        if centerY < bottom { return index }
    }
    // Past the end: the last page, rather than an index nobody can use.
    return max(0, heights.count - 1)
}
