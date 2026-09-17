import Foundation

public enum PdfMarkState: Sendable, Equatable { case pending, accepted, rejected }

/// A reviewable region drawn over a page, such as a redaction suggestion.
public struct PdfMark: Equatable, Sendable {
    public let id: String
    public let pageIndex: Int
    public let rects: [PdfRect]
    public var state: PdfMarkState
    /// Shown inside the mark, such as the value a form proposal would fill in.
    public let label: String?

    public init(id: String, pageIndex: Int, rects: [PdfRect], state: PdfMarkState = .pending, label: String? = nil) {
        self.id = id
        self.pageIndex = pageIndex
        self.rects = rects
        self.state = state
        self.label = label
    }
}

// Local to one viewer: none of these emit an event, so a sync transport never carries a
// review, and none touch the document.
extension PdfViewer {
    public func setMarks(_ marks: [PdfMark]) { self.marks = marks }

    public func setAllMarks(_ state: PdfMarkState) {
        marks = marks.map { var mark = $0; mark.state = state; return mark }
    }

    /// The id of the topmost mark under a point on a page — the last one set — or nil.
    public func markAt(page: Int, point: PdfPoint) -> String? {
        marks.last { $0.pageIndex == page && $0.rects.contains { $0.contains(point) } }?.id
    }

    /// Cycles the tapped mark pending → accepted → rejected → pending. Returns its id, or nil.
    @discardableResult
    public func tapMark(page: Int, point: PdfPoint) -> String? {
        guard let id = markAt(page: page, point: point), let i = marks.firstIndex(where: { $0.id == id }) else { return nil }
        switch marks[i].state {
        case .pending: marks[i].state = .accepted
        case .accepted: marks[i].state = .rejected
        case .rejected: marks[i].state = .pending
        }
        return id
    }
}
