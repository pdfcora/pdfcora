import SwiftUI
import PdfiumKit

/// What a tap or drag on the page does.
enum EditorTool: String, CaseIterable, Identifiable {
    case select, ink, note, highlight

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .select:    "hand.tap"
        case .ink:       "scribble"
        case .note:      "note.text"
        case .highlight: "highlighter"
        }
    }

    var hint: String {
        switch self {
        case .select:    "Tap a field or annotation"
        case .ink:       "Drag to draw"
        case .note:      "Tap to place a note"
        case .highlight: "Drag over an area"
        }
    }
}

/// Viewer, form filling, and annotation on one surface.
///
/// Hit-testing is the whole trick: every tap is converted to PDF space with
/// `PdfViewTransform`, then matched against the rects the SDK reports for form fields
/// and annotations.
struct EditorScreen: View {
    @EnvironmentObject private var store: DocumentStore

    @State private var pageIndex = 0
    @State private var image: UIImage?
    @State private var pageSize: PdfSize?
    @State private var fields: [PdfFormField] = []
    @State private var annotations: [PdfAnnotation] = []

    @State private var tool: EditorTool = .select
    @State private var stroke: [CGPoint] = []
    @State private var dragRect: CGRect?
    @State private var createdCount = 0

    @State private var editingField: PdfFormField?
    @State private var fieldDraft = ""
    @State private var selectedAnnotation: Int?
    @State private var notePoint: PdfPoint?
    @State private var noteDraft = ""
    @State private var status: String?

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            canvas
            footer
        }
        .navigationTitle("Editor")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: pageIndex) { await reload() }
        .sheet(item: $editingField) { field in
            TextFieldSheet(name: field.base.name ?? "Field", text: $fieldDraft) {
                Task { await commitField(field) }
            }
        }
        .alert("Note", isPresented: Binding(get: { notePoint != nil },
                                            set: { if !$0 { notePoint = nil } })) {
            TextField("Contents", text: $noteDraft)
            Button("Add") { Task { await commitNote() } }
            Button("Cancel", role: .cancel) { notePoint = nil }
        }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack {
            ForEach(EditorTool.allCases) { item in
                Button {
                    tool = item
                    selectedAnnotation = nil
                } label: {
                    Image(systemName: item.icon)
                        .frame(width: 38, height: 32)
                        .background(tool == item ? Color.accentColor.opacity(0.18) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 7))
                }
                .accessibilityIdentifier("tool-\(item.rawValue)")
            }

            Divider().frame(height: 24)

            Button { Task { await undo() } } label: { Image(systemName: "arrow.uturn.backward") }
                .disabled(createdCount == 0)
                .accessibilityIdentifier("editor-undo")

            Button(role: .destructive) { Task { await deleteSelected() } } label: {
                Image(systemName: "trash")
            }
            .disabled(selectedAnnotation == nil)

            Spacer()

            Button { Task { await save() } } label: { Image(systemName: "square.and.arrow.down") }
                .accessibilityIdentifier("editor-save")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: - Canvas

    private var canvas: some View {
        GeometryReader { geometry in
            ScrollView {
                if let image, let pageSize {
                    let transform = PdfViewTransform(page: pageSize,
                                                     fittingWidth: Double(geometry.size.width - 24))
                    ZStack(alignment: .topLeading) {
                        Image(uiImage: image)
                            .resizable()
                            .frame(width: transform.viewSize.width, height: transform.viewSize.height)

                        overlay(transform)
                    }
                    .frame(width: transform.viewSize.width, height: transform.viewSize.height)
                    .contentShape(Rectangle())
                    .gesture(dragGesture(transform))
                    .padding(12)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
            }
        }
    }

    /// Field outlines, annotation selection, and the in-progress gesture.
    @ViewBuilder
    private func overlay(_ transform: PdfViewTransform) -> some View {
        ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
            Rectangle()
                .stroke(Color.accentColor.opacity(0.55), lineWidth: 1)
                .frame(width: transform.toView(field.base.rect).width,
                       height: transform.toView(field.base.rect).height)
                .offset(x: transform.toView(field.base.rect).minX,
                        y: transform.toView(field.base.rect).minY)
        }

        if let selected = selectedAnnotation,
           let annotation = annotations.first(where: { $0.base.index == selected }) {
            let box = transform.toView(annotation.base.rect)
            Rectangle()
                .stroke(Color.orange, lineWidth: 2)
                .frame(width: max(box.width, 8), height: max(box.height, 8))
                .offset(x: box.minX, y: box.minY)
        }

        if stroke.count > 1 {
            Path { path in
                path.addLines(stroke)
            }
            .stroke(Color.blue, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }

        if let rect = dragRect {
            Rectangle()
                .fill(Color.yellow.opacity(0.35))
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    private func dragGesture(_ transform: PdfViewTransform) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                switch tool {
                case .ink:       stroke.append(value.location)
                case .highlight: dragRect = CGRect(from: value.startLocation, to: value.location)
                case .select, .note: break
                }
            }
            .onEnded { value in
                Task { await finish(gesture: value, transform: transform) }
            }
    }

    private func finish(gesture: DragGesture.Value, transform: PdfViewTransform) async {
        switch tool {
        case .select:
            handleSelect(at: transform.toPdf(gesture.location))
        case .note:
            notePoint = transform.toPdf(gesture.location)
            noteDraft = ""
        case .ink:
            let points = stroke.map { transform.toPdf($0) }
            stroke = []
            guard points.count > 1 else { return }
            await create { page in
                try await page.addInk(strokes: [points], color: PdfColor(red: 0, green: 90, blue: 220))
            }
        case .highlight:
            guard let rect = dragRect, rect.width > 4, rect.height > 4 else { dragRect = nil; return }
            let pdf = transform.toPdf(rect)
            dragRect = nil
            await create { page in
                try await page.addHighlight(quads: [PdfQuad(
                    p1: PdfPoint(x: pdf.left, y: pdf.top),
                    p2: PdfPoint(x: pdf.right, y: pdf.top),
                    p3: PdfPoint(x: pdf.left, y: pdf.bottom),
                    p4: PdfPoint(x: pdf.right, y: pdf.bottom))])
            }
        }
    }

    /// Topmost form field wins; otherwise the topmost annotation.
    private func handleSelect(at point: PdfPoint) {
        if let field = fields.last(where: { $0.base.rect.contains(point) }) {
            selectedAnnotation = nil
            activate(field)
            return
        }
        selectedAnnotation = annotations.last(where: { $0.base.rect.contains(point) })?.base.index
    }

    /// Each field kind gets the interaction that suits it.
    private func activate(_ field: PdfFormField) {
        switch field {
        case .text(let f):
            fieldDraft = f.value
            editingField = field
        case .checkBox(let f), .radioButton(let f):
            Task { await setChecked(!f.isChecked, on: field) }
        case .comboBox(let f), .listBox(let f):
            let next = ((f.selectedIndices.first ?? -1) + 1) % max(f.options.count, 1)
            Task { await setOption(next, on: field) }
        case .pushButton, .signature, .unknown:
            status = "This field type is not editable"
        }
    }

    // MARK: - Mutations

    private func create(_ action: (PdfPage) async throws -> Int) async {
        guard let page = try? await store.document?.page(pageIndex) else { return }
        do {
            _ = try await action(page)
            createdCount += 1
            await reload()
        } catch let error as PdfError {
            status = error.description
        } catch {
            status = error.localizedDescription
        }
    }

    private func commitField(_ field: PdfFormField) async {
        guard let page = try? await store.document?.page(pageIndex) else { return }
        try? await page.setText(fieldDraft, forFieldAt: field.base.annotationIndex)
        editingField = nil
        await reload()
    }

    private func setChecked(_ value: Bool, on field: PdfFormField) async {
        guard let page = try? await store.document?.page(pageIndex) else { return }
        try? await page.setChecked(value, forFieldAt: field.base.annotationIndex)
        await reload()
    }

    private func setOption(_ index: Int, on field: PdfFormField) async {
        guard let page = try? await store.document?.page(pageIndex) else { return }
        try? await page.setOption(index, selected: true, forFieldAt: field.base.annotationIndex)
        await reload()
    }

    private func commitNote() async {
        guard let point = notePoint else { return }
        notePoint = nil
        let rect = PdfRect(left: point.x, bottom: point.y - 24, right: point.x + 24, top: point.y)
        let text = noteDraft
        await create { page in try await page.addNote(rect: rect, contents: text) }
    }

    private func deleteSelected() async {
        guard let index = selectedAnnotation,
              let page = try? await store.document?.page(pageIndex) else { return }
        try? await page.removeAnnotation(at: index)
        selectedAnnotation = nil
        await reload()
    }

    /// Undo removes the most recent annotation. Indices shift on delete, so anything
    /// finer-grained would need an identity the SDK does not expose.
    private func undo() async {
        guard createdCount > 0,
              let page = try? await store.document?.page(pageIndex),
              !annotations.isEmpty else { return }
        try? await page.removeAnnotation(at: annotations.count - 1)
        createdCount -= 1
        await reload()
    }

    private func save() async {
        guard let document = store.document else { return }
        do {
            let bytes = try await document.data()
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("pdfiumkit-edited.pdf")
            try bytes.write(to: url, options: .atomic)
            status = "Saved \(ByteCountFormatter.string(fromByteCount: Int64(bytes.count), countStyle: .file))"
        } catch let error as PdfError {
            status = error.description
        } catch {
            status = error.localizedDescription
        }
    }

    // MARK: - Loading

    private func reload() async {
        guard let document = store.document,
              let page = try? await document.page(pageIndex) else { return }
        pageSize = try? await page.size
        fields = (try? await page.formFields()) ?? []
        annotations = (try? await page.annotations()) ?? []
        image = try? await page.render(width: 1400, options: [.annotations, .forms])
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 4) {
            if let status {
                Text(status).font(.caption).foregroundColor(.secondary)
            } else {
                Text("\(tool.hint) · \(fields.count) field\(fields.count == 1 ? "" : "s") · \(annotations.count) annotation\(annotations.count == 1 ? "" : "s")")
                    .font(.caption).foregroundColor(.secondary)
            }
            HStack {
                Button { pageIndex -= 1 } label: { Image(systemName: "chevron.left") }
                    .disabled(pageIndex == 0)
                Spacer()
                Text("Page \(pageIndex + 1) of \(store.pageCount)").font(.callout.monospacedDigit())
                Spacer()
                Button { pageIndex += 1 } label: { Image(systemName: "chevron.right") }
                    .disabled(pageIndex >= store.pageCount - 1)
            }
        }
        .padding()
        .background(.bar)
    }
}

// MARK: - Support

private struct TextFieldSheet: View {
    let name: String
    @Binding var text: String
    let onCommit: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            Form {
                TextField(name, text: $text)
            }
            .navigationTitle(name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onCommit(); dismiss() }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}

extension PdfFormField: Identifiable {
    public var id: Int { base.annotationIndex }
}

private extension CGRect {
    init(from a: CGPoint, to b: CGPoint) {
        self.init(x: min(a.x, b.x), y: min(a.y, b.y),
                  width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
}
