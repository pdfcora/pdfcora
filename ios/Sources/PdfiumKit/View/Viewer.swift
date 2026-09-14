import Foundation
import UIKit

public struct PdfViewerOptions: Sendable {
    public let sessionId: String
    /// Viewport changes are coalesced over this window, in seconds. Edits will not be.
    ///
    /// Seconds rather than `Duration`, which is iOS 16+ and this package supports 15.
    public let coalesceInterval: TimeInterval

    public init(sessionId: String = UUID().uuidString,
                coalesceInterval: TimeInterval = 0.05) {
        self.sessionId = sessionId
        self.coalesceInterval = coalesceInterval
    }
}

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
