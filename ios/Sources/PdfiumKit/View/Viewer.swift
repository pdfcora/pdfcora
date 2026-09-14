import Foundation
import UIKit

public struct PdfViewerOptions: Sendable {
    public let sessionId: String
    /// A follower may look wherever it likes but may not change the document.
    ///
    /// Concurrent editing is deliberately out of scope: two people editing one
    /// annotation is a distributed-systems problem, and last-writer-wins silently
    /// discards work.
    public let role: PdfViewerRole
    /// When set, only this session's edits are applied. Others are ignored.
    public let presenterId: String?
    /// Viewport changes are coalesced over this window, in seconds. Edits will not be.
    ///
    /// Seconds rather than `Duration`, which is iOS 16+ and this package supports 15.
    public let coalesceInterval: TimeInterval

    public init(sessionId: String = UUID().uuidString,
                coalesceInterval: TimeInterval = 0.05,
                role: PdfViewerRole = .presenter,
                presenterId: String? = nil) {
        self.sessionId = sessionId
        self.coalesceInterval = coalesceInterval
        self.role = role
        self.presenterId = presenterId
    }
}

public enum PdfViewerRole: Sendable { case presenter, follower }

/// Where a viewer is looking, and what changes it.
///
/// Headless: it owns no view. The app draws, asks ``scrollOffset()`` where to scroll and
/// ``render(options:background:)`` what to paint, and reports gestures back in.
/// Everything that changes it emits an event, and ``apply(_:)`` is the inverse — which is
/// what lets two viewers on different platforms stay in step.
///
/// An `actor` because ``PdfDocument`` is one. It never holds its own executor while
/// awaiting the document's.
public actor PdfViewer {
    public private(set) var state: PdfViewState
    public private(set) var selection: PdfSelection?
    public private(set) var tool: PdfTool = .select

    private let document: PdfDocument
    private let sessionId: String
    private let role: PdfViewerRole
    private let presenterId: String?
    private let coalesceInterval: TimeInterval
    private var viewport: CGSize
    private var pageSize: PdfSize
    private let pageCount: Int

    private var sequence = 0
    /// Highest sequence seen per remote session, so late delivery cannot rewind us.
    private var seen: [String: Int] = [:]
    private var listeners: [UUID: @Sendable (PdfViewEvent) -> Void] = [:]
    private var pending: PdfViewState?
    private var coalescing: Task<Void, Never>?

    public init(document: PdfDocument, viewport: CGSize,
                options: PdfViewerOptions = .init()) async throws {
        self.document = document
        self.viewport = viewport
        self.sessionId = options.sessionId
        self.role = options.role
        self.presenterId = options.presenterId
        self.coalesceInterval = options.coalesceInterval
        self.pageCount = await document.pageCount
        self.pageSize = try await document.page(0).size
        self.state = PdfViewState(
            pageIndex: 0,
            center: PdfPoint(x: pageSize.width / 2, y: pageSize.height / 2),
            zoom: PdfZoom.fitting(width: viewport.width, page: pageSize),
            rotation: .none,
            layout: .single)
    }

    // MARK: - Observing

    @discardableResult
    public func onEvent(_ listener: @escaping @Sendable (PdfViewEvent) -> Void) -> UUID {
        let token = UUID()
        listeners[token] = listener
        return token
    }

    public func removeListener(_ token: UUID) { listeners[token] = nil }

    // MARK: - Geometry

    public func transform() -> PdfViewTransform {
        PdfViewTransform(page: pageSize, scale: state.zoom.scale)
    }

    /// Where the app should scroll so the state's centre sits in the middle.
    public func scrollOffset() -> CGPoint {
        transform().scrollOffset(centering: state.center, in: viewport)
    }

    public func render(options: PdfRenderOptions = .default,
                       background: PdfColor = PdfColor(red: 255, green: 255, blue: 255)) async throws -> UIImage {
        // Rendered at the zoomed size rather than scaling one bitmap up, so text stays sharp.
        let width = Int((pageSize.width * state.zoom.scale).rounded())
        return try await document.page(state.pageIndex)
            .render(width: min(max(width, 1), 4000), options: options, background: background)
    }

    // MARK: - Viewport

    public func setViewport(_ size: CGSize) {
        viewport = size
        // A fit is a promise about the window, so it is re-derived. A free zoom is the
        // user's deliberate choice and survives.
        let zoom = state.zoom.mode == .free ? state.zoom : refit(state.zoom.mode)
        update(PdfViewState(pageIndex: state.pageIndex, center: state.center, zoom: zoom,
                            rotation: state.rotation, layout: state.layout))
    }

    public func scroll(to center: PdfPoint, page: Int? = nil) {
        update(PdfViewState(pageIndex: clampPage(page ?? state.pageIndex), center: center,
                            zoom: state.zoom, rotation: state.rotation, layout: state.layout))
    }

    public func scrollBy(_ delta: CGSize) {
        let offset = scrollOffset()
        let moved = CGPoint(x: offset.x + delta.width, y: offset.y + delta.height)
        update(PdfViewState(pageIndex: state.pageIndex,
                            center: transform().center(forScrollOffset: moved, in: viewport),
                            zoom: state.zoom, rotation: state.rotation, layout: state.layout))
    }

    public func goToPage(_ index: Int) async throws {
        let page = clampPage(index)
        pageSize = try await document.page(page).size
        let zoom = state.zoom.mode == .free ? state.zoom : refit(state.zoom.mode)
        update(PdfViewState(pageIndex: page,
                            center: PdfPoint(x: pageSize.width / 2, y: pageSize.height / 2),
                            zoom: zoom, rotation: state.rotation, layout: state.layout))
    }

    public func zoom(to zoom: PdfZoom) {
        update(PdfViewState(pageIndex: state.pageIndex, center: state.center, zoom: zoom,
                            rotation: state.rotation, layout: state.layout))
    }

    public func zoomIn() { zoom(to: state.zoom.stepped(1)) }
    public func zoomOut() { zoom(to: state.zoom.stepped(-1)) }
    public func fitWidth() { zoom(to: refit(.fitWidth)) }
    public func fitPage() { zoom(to: refit(.fitPage)) }

    public func setRotation(_ rotation: PdfPageRotation) {
        update(PdfViewState(pageIndex: state.pageIndex, center: state.center, zoom: state.zoom,
                            rotation: rotation, layout: state.layout))
    }

    public func setLayout(_ layout: PdfPageLayout) {
        update(PdfViewState(pageIndex: state.pageIndex, center: state.center, zoom: state.zoom,
                            rotation: state.rotation, layout: layout))
    }

    // MARK: - Selection and tools

    public func selectRegion(page: Int, rect: PdfRect) { setSelection(.region(page: page, rect: rect)) }
    public func selectAnnotation(page: Int, index: Int) { setSelection(.annotation(page: page, index: index)) }
    public func clearSelection() { setSelection(nil) }

    public func setTool(_ tool: PdfTool) {
        self.tool = tool
        emit(.tool(tool))
    }

    // MARK: - Editing
    //
    // Every method delegates to the existing page API and then emits. Two code paths
    // producing annotations would drift, and the bug would surface through only one of
    // them — ViewerTests asserts byte identity to stop that.
    //
    // A follower refuses to edit locally. It may still scroll and zoom: following is not
    // the same as being frozen.

    /// The bytes this viewer's document was opened from. An edit is refused unless the
    /// sender's matches.
    public var documentFingerprint: String { get async { await document.fingerprint } }

    @discardableResult
    public func addNote(rect: PdfRect, contents: String,
                        color: PdfColor = .yellow) async throws -> Int {
        try requirePresenter()
        let index = try await document.page(state.pageIndex)
            .addNote(rect: rect, contents: contents, color: color)
        await emitEdit(.noteAdded(page: state.pageIndex, rect: rect, contents: contents, color: color))
        return index
    }

    @discardableResult
    public func addInk(strokes: [[PdfPoint]], color: PdfColor = .black,
                       lineWidth: Double = 2) async throws -> Int {
        try requirePresenter()
        let index = try await document.page(state.pageIndex)
            .addInk(strokes: strokes, color: color, lineWidth: lineWidth)
        await emitEdit(.inkAdded(page: state.pageIndex, strokes: strokes,
                                 color: color, lineWidth: lineWidth))
        return index
    }

    @discardableResult
    public func addHighlight(_ quads: [PdfQuad], color: PdfColor = .yellow) async throws -> Int {
        try requirePresenter()
        let index = try await document.page(state.pageIndex).addHighlight(quads: quads, color: color)
        await emitEdit(.highlightAdded(page: state.pageIndex, quads: quads, color: color))
        return index
    }

    public func removeAnnotation(at index: Int) async throws {
        try requirePresenter()
        try await document.page(state.pageIndex).removeAnnotation(at: index)
        await emitEdit(.annotationRemoved(page: state.pageIndex, index: index))
    }

    public func setFieldText(_ value: String, at annotationIndex: Int) async throws {
        try requirePresenter()
        try await document.page(state.pageIndex).setText(value, forFieldAt: annotationIndex)
        await emitEdit(.fieldTextSet(page: state.pageIndex, annotationIndex: annotationIndex, value: value))
    }

    public func setFieldChecked(_ checked: Bool, at annotationIndex: Int) async throws {
        try requirePresenter()
        try await document.page(state.pageIndex).setChecked(checked, forFieldAt: annotationIndex)
        await emitEdit(.fieldCheckedSet(page: state.pageIndex, annotationIndex: annotationIndex, checked: checked))
    }

    public func setFieldOption(_ option: Int, selected: Bool, at annotationIndex: Int) async throws {
        try requirePresenter()
        try await document.page(state.pageIndex)
            .setOption(option, selected: selected, forFieldAt: annotationIndex)
        await emitEdit(.fieldOptionSet(page: state.pageIndex, annotationIndex: annotationIndex,
                                       option: option, selected: selected))
    }

    /// Removes content so it cannot be recovered.
    ///
    /// **Save with ``PdfSaveMode/full`` afterwards** — an incremental save leaves the
    /// original content stream in the file, and the removed content with it.
    @discardableResult
    public func redact(_ targets: [PdfRedactionTarget]) async throws -> PdfRedactionReport {
        try requirePresenter()
        let report = try await document.redact(targets)
        await emitEdit(.redacted(targets: targets))
        return report
    }

    private func requirePresenter() throws {
        if role == .follower { throw PdfError.readOnlyFollower }
    }

    private func emitEdit(_ edit: PdfEdit) async {
        // Edits bypass the viewport throttle. A viewport change may be dropped in favour
        // of a later one; an annotation added is not superseded by the next.
        let fingerprint = await document.fingerprint
        sequence += 1
        let event = PdfViewEvent(sequence: sequence, sessionId: sessionId,
                                 origin: .local, change: .edit(edit),
                                 documentFingerprint: fingerprint)
        for listener in listeners.values { listener(event) }
    }

    /// Replays a peer's edit by making the same call. Emits nothing.
    private func applyEdit(_ edit: PdfEdit) async throws {
        switch edit {
        case .noteAdded(let page, let rect, let contents, let color):
            _ = try await document.page(page).addNote(rect: rect, contents: contents, color: color)
        case .inkAdded(let page, let strokes, let color, let lineWidth):
            _ = try await document.page(page).addInk(strokes: strokes, color: color, lineWidth: lineWidth)
        case .highlightAdded(let page, let quads, let color):
            _ = try await document.page(page).addHighlight(quads: quads, color: color)
        case .annotationRemoved(let page, let index):
            try await document.page(page).removeAnnotation(at: index)
        case .fieldTextSet(let page, let annotationIndex, let value):
            try await document.page(page).setText(value, forFieldAt: annotationIndex)
        case .fieldCheckedSet(let page, let annotationIndex, let checked):
            try await document.page(page).setChecked(checked, forFieldAt: annotationIndex)
        case .fieldOptionSet(let page, let annotationIndex, let option, let selected):
            try await document.page(page).setOption(option, selected: selected, forFieldAt: annotationIndex)
        case .redacted(let targets):
            _ = try await document.redact(targets)
        }
    }

    /// Applies a peer's edit, refusing one meant for other bytes.
    public func applyEditEvent(_ event: PdfViewEvent) async throws {
        guard case .edit(let edit) = event.change else { return }
        if let highest = seen[event.sessionId], event.sequence <= highest { return }

        // Only edits depend on the bytes. Viewport events are exempt: two people reading
        // different documents can still be told where the other is looking.
        let mine = await document.fingerprint
        if let theirs = event.documentFingerprint, theirs != mine {
            throw PdfError.documentMismatch(expected: mine, received: theirs)
        }
        // A stray edit is ignored rather than thrown: in a broadcast transport everyone
        // hears everyone, and throwing would make a third participant's edit an error
        // on every peer.
        if let presenterId, event.sessionId != presenterId { return }

        seen[event.sessionId] = event.sequence
        try await applyEdit(edit)
    }

    // MARK: - Sync

    /// Applies a peer's event.
    ///
    /// Emits nothing — without that, two synced viewers echo each other forever — and
    /// ignores anything at or below the highest sequence already seen from that session,
    /// so late delivery cannot rewind the view.
    public func apply(_ event: PdfViewEvent) {
        if let highest = seen[event.sessionId], event.sequence <= highest { return }
        seen[event.sessionId] = event.sequence

        switch event.change {
        case .viewport(let incoming):
            // A fit is re-derived for *this* window; a free zoom is adopted verbatim.
            let zoom = incoming.zoom.mode == .free ? incoming.zoom : refit(incoming.zoom.mode)
            state = PdfViewState(pageIndex: incoming.pageIndex, center: incoming.center, zoom: zoom,
                                 rotation: incoming.rotation, layout: incoming.layout)
        case .selection(let incoming):
            selection = incoming
        case .tool(let incoming):
            tool = incoming
        case .edit:
            // Replayed in `apply(_:)`'s async path; see the editing extension.
            break
        }
    }

    /// Flushes any pending viewport change immediately. For tests and for teardown.
    public func flush() {
        coalescing?.cancel()
        coalescing = nil
        if let latest = pending {
            pending = nil
            emit(.viewport(latest))
        }
    }

    // MARK: - Internals

    private func clampPage(_ index: Int) -> Int { max(0, min(index, pageCount - 1)) }

    private func refit(_ mode: PdfZoomMode) -> PdfZoom {
        mode == .fitWidth
            ? PdfZoom.fitting(width: viewport.width, page: pageSize)
            : PdfZoom.fitting(size: viewport, page: pageSize)
    }

    private func setSelection(_ selection: PdfSelection?) {
        self.selection = selection
        emit(.selection(selection))
    }

    private func update(_ next: PdfViewState) {
        state = next
        // Viewport changes coalesce: a drag produces them at gesture rate and only the
        // latest matters. Selection and tool changes are emitted immediately, since each
        // is meaningful on its own and dropping one loses information.
        pending = next
        guard coalescing == nil else { return }
        coalescing = Task { [coalesceInterval] in
            try? await Task.sleep(nanoseconds: UInt64(max(0, coalesceInterval) * 1_000_000_000))
            await self.flush()
        }
    }

    private func emit(_ change: PdfViewChange) {
        sequence += 1
        let event = PdfViewEvent(sequence: sequence, sessionId: sessionId,
                                 origin: .local, change: change)
        for listener in listeners.values { listener(event) }
    }
}
