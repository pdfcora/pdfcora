import SwiftUI
import PdfiumKit

/// A drop-in viewer: the page, gestures and a configurable toolbar.
///
/// It drives a headless ``PdfViewer`` and owns no state of its own, so behaviour lives
/// in one tested place and this layer can be rewritten without touching the contract
/// underneath. An app that wants full control can use ``PdfViewer`` directly.
public struct PdfViewerView: View {
    private let document: PdfDocument
    private let toolbar: PdfToolbarConfiguration
    private let theme: PdfViewerTheme
    private let onSave: ((Data) -> Void)?

    @Environment(\.displayScale) private var displayScale
    @State private var viewer: PdfViewer?
    @State private var image: UIImage?
    @State private var state: PdfViewState?
    @State private var tool: PdfTool = .select
    @State private var selection: PdfSelection?
    @State private var dragRect: CGRect?
    @State private var stroke: [CGPoint] = []
    @State private var viewport: CGSize = .zero
    @State private var createdCount = 0
    @State private var status: String?
    @State private var failure: String?
    @State private var pendingNote: PdfPoint?
    @State private var noteDraft = ""

    public init(document: PdfDocument,
                toolbar: PdfToolbarConfiguration = .default,
                theme: PdfViewerTheme = .light,
                onSave: ((Data) -> Void)? = nil) {
        self.document = document
        self.toolbar = toolbar
        self.theme = theme
        self.onSave = onSave
    }

    public var body: some View {
        VStack(spacing: 0) {
            PdfToolbarView(items: toolbar.items, theme: theme, tool: tool,
                           canUndo: createdCount > 0, hasSelection: selection != nil,
                           perform: perform)
            page
            if let status {
                Text(status).font(.caption).foregroundColor(.secondary).padding(.vertical, 4)
            }
        }
        .background(theme.background)
        .task { await open() }
    }

    private var page: some View {
        GeometryReader { geometry in
            ScrollView([.horizontal, .vertical]) {
                if let image, let state {
                    ZStack(alignment: .topLeading) {
                        Image(uiImage: image)
                            .resizable()
                            .frame(width: CGFloat(image.size.width), height: CGFloat(image.size.height))
                            .background(theme.pageBackground)
                            .shadow(color: theme.pageShadow, radius: 4)
                            .contentShape(Rectangle())
                            .gesture(drag)
                        overlay(state)
                    }
                    .padding(12)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40).opacity(failure == nil ? 1 : 0)
                }
            }
            // Outside the scroll view, which scrolls both ways and so would never wrap it.
            .overlay {
                if let failure {
                    Text(failure)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(24)
                        .frame(width: geometry.size.width)
                }
            }
            .onAppear { resize(geometry.size) }
            .onChange(of: geometry.size) { resize($0) }
        }
    }

    @ViewBuilder
    private func overlay(_ state: PdfViewState) -> some View {
        if let rect = dragRect {
            Rectangle()
                .fill(tool == .redact ? theme.redactionFill : theme.accent.opacity(0.3))
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
        }
        if stroke.count > 1 {
            Path { $0.addLines(stroke) }
                .stroke(theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }
    }

    // MARK: - Gestures

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                switch tool {
                case .ink: stroke.append(value.location)
                case .highlight, .redact:
                    dragRect = CGRect(from: value.startLocation, to: value.location)
                case .select, .note: break
                }
            }
            .onEnded { value in Task { await finish(value) } }
    }

    private func finish(_ gesture: DragGesture.Value) async {
        guard let viewer else { return }
        let transform = await viewer.transform()

        switch tool {
        case .select:
            selection = nil
        case .note:
            let point = transform.toPdf(gesture.location)
            try? await viewer.addNote(rect: PdfRect(left: point.x, bottom: point.y - 24,
                                                    right: point.x + 24, top: point.y),
                                      contents: "Note", color: .yellow)
            createdCount += 1
            await refresh()
        case .ink:
            let points = stroke.map { transform.toPdf($0) }
            stroke = []
            guard points.count > 1 else { return }
            try? await viewer.addInk(strokes: [points])
            createdCount += 1
            await refresh()
        case .highlight, .redact:
            guard let rect = dragRect, rect.width > 4, rect.height > 4 else { dragRect = nil; return }
            let pdf = transform.toPdf(rect)
            dragRect = nil
            if tool == .redact {
                if let report = try? await viewer.redact([.region(pdf, pageIndex: 0)]) {
                    status = describe(report)
                }
            } else {
                try? await viewer.addHighlight([PdfQuad(
                    p1: PdfPoint(x: pdf.left, y: pdf.top), p2: PdfPoint(x: pdf.right, y: pdf.top),
                    p3: PdfPoint(x: pdf.left, y: pdf.bottom), p4: PdfPoint(x: pdf.right, y: pdf.bottom))])
                createdCount += 1
            }
            await refresh()
        }
    }

    // MARK: - Toolbar actions

    private func perform(_ item: PdfToolbarItem) {
        if let action = item.action { action(); return }
        Task {
            guard let viewer else { return }
            switch item.kind {
            case .tool(let selected):
                tool = selected
                await viewer.setTool(selected)
            case .undo:
                guard createdCount > 0 else { return }
                let count = try? await document.page(0).annotations().count
                if let count, count > 0 { try? await viewer.removeAnnotation(at: count - 1) }
                createdCount -= 1
                await refresh()
            case .deleteSelection:
                if case .annotation(_, let index) = selection {
                    try? await viewer.removeAnnotation(at: index)
                    selection = nil
                    await refresh()
                }
            case .zoomIn: await viewer.zoomIn(); await refresh()
            case .zoomOut: await viewer.zoomOut(); await refresh()
            case .fitWidth: await viewer.fitWidth(); await refresh()
            case .pageBack:
                let current = await viewer.state.pageIndex
                try? await viewer.goToPage(max(0, current - 1))
                await refresh()
            case .pageForward:
                let current = await viewer.state.pageIndex
                try? await viewer.goToPage(current + 1)
                await refresh()
            case .save:
                if let data = try? await document.data(mode: .full) {
                    onSave?(data)
                    status = "Saved \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))"
                }
            case .spacer, .divider, .custom: break
            }
        }
    }

    // MARK: - Plumbing

    private func open() async {
        guard viewer == nil, viewport.width > 0 else { return }
        // Shown in place of the page: swallowing the error left a spinner turning forever.
        do {
            viewer = try await PdfViewer(document: document, viewport: viewport)
        } catch {
            failure = "Could not show the document: \(error)"
            return
        }
        await refresh()
    }

    private func resize(_ size: CGSize) {
        let usable = CGSize(width: max(1, size.width - 24), height: max(1, size.height - 24))
        viewport = usable
        Task {
            if viewer == nil { await open() } else {
                await viewer?.setViewport(usable)
                await refresh()
            }
        }
    }

    private func refresh() async {
        guard let viewer else { return }
        state = await viewer.state
        image = try? await viewer.render(scale: displayScale)
    }

    private func describe(_ report: PdfRedactionReport) -> String {
        let counts = [(report.textObjects, "text object"), (report.images, "image"),
                      (report.paths, "path"), (report.annotations, "annotation")]
            .filter { $0.0 > 0 }
            .map { "\($0.0) \($0.1)\($0.0 == 1 ? "" : "s")" }
        return counts.isEmpty
            ? "Nothing in that region to redact"
            : "Redacted \(counts.joined(separator: ", ")) — save to write it out"
    }
}

private extension CGRect {
    init(from a: CGPoint, to b: CGPoint) {
        self.init(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
}
