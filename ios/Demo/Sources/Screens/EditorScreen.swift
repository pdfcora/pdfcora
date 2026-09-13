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
        case .select:    "Edit fields on the page"
        case .ink:       "Drag to draw"
        case .note:      "Tap to place a note"
        case .highlight: "Drag over an area"
        }
    }
}

/// Viewer, form filling, and annotation on one surface.
///
/// The page is rendered **without** the `.forms` flag, so PDFium draws each widget's
/// border and background but not its value. That leaves every field's rectangle free
/// for a live SwiftUI control positioned on it — so the page behaves like a form
/// rather than a picture of one. `PdfViewTransform` does the placement and the
/// hit-testing.
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

    /// Live text per field, keyed by annotation index, so typing does not re-render
    /// the page on every keystroke.
    @State private var drafts: [Int: String] = [:]
    @FocusState private var focusedField: Int?

    @State private var selectedAnnotation: Int?
    @State private var pendingNote: PdfPoint?
    @State private var noteDraft = ""
    @FocusState private var noteFocused: Bool
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
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack {
            ForEach(EditorTool.allCases) { item in
                Button {
                    tool = item
                    selectedAnnotation = nil
                    focusedField = nil
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
                            .contentShape(Rectangle())
                            .gesture(dragGesture(transform))

                        annotationLayer(transform)
                        formLayer(transform)
                        pendingNoteEditor(transform)
                    }
                    .frame(width: transform.viewSize.width, height: transform.viewSize.height)
                    .padding(12)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
            }
        }
    }

    /// Live controls sitting exactly where the fields are.
    @ViewBuilder
    private func formLayer(_ transform: PdfViewTransform) -> some View {
        ForEach(fields) { field in
            let box = transform.toView(field.base.rect)
            fieldControl(field, height: box.height)
                .frame(width: box.width, height: box.height, alignment: .leading)
                .offset(x: box.minX, y: box.minY)
        }
    }

    /// Each field kind gets the control that suits it, rendered in place.
    @ViewBuilder
    private func fieldControl(_ field: PdfFormField, height: CGFloat) -> some View {
        let index = field.base.annotationIndex
        // Fit the text to the field box, within readable bounds.
        let fontSize = max(9, min(17, height * 0.62))

        switch field {
        case .text(let f):
            TextField("", text: Binding(
                get: { drafts[index] ?? f.value },
                set: { drafts[index] = $0 }
            ))
            .font(.system(size: fontSize))
            .textFieldStyle(.plain)
            .padding(.horizontal, 3)
            .focused($focusedField, equals: index)
            .submitLabel(.done)
            .onSubmit { Task { await commitText(index) } }
            .onChange(of: focusedField) { focus in
                // Commit when focus moves away, so the page re-renders once.
                if focus != index, drafts[index] != nil { Task { await commitText(index) } }
            }
            .background(Color.white.opacity(0.001))   // keeps the whole box tappable
            .border(Color.accentColor.opacity(0.6))
            .accessibilityIdentifier("field-\(index)")

        case .checkBox(let f), .radioButton(let f):
            // The widget already draws its own box; without `.forms` it just never
            // draws the check. So supply only the mark, not another frame.
            Button {
                Task { await setChecked(!f.isChecked, on: field) }
            } label: {
                Image(systemName: "checkmark")
                    .font(.system(size: fontSize, weight: .bold))
                    .foregroundColor(.accentColor)
                    .opacity(f.isChecked ? 1 : 0)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier("field-\(index)")

        case .comboBox(let f), .listBox(let f):
            Menu {
                ForEach(Array(f.options.enumerated()), id: \.offset) { i, option in
                    Button(option.isEmpty ? "(blank)" : option) {
                        Task { await setOption(i, on: field) }
                    }
                }
            } label: {
                HStack(spacing: 2) {
                    Text(f.value.isEmpty ? "—" : f.value)
                        .font(.system(size: fontSize))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").font(.system(size: fontSize * 0.7))
                }
                .padding(.horizontal, 3)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .border(Color.accentColor.opacity(0.6))
            }
            .accessibilityIdentifier("field-\(index)")

        case .pushButton, .signature, .unknown:
            Rectangle().stroke(Color.secondary.opacity(0.4), style: StrokeStyle(dash: [3, 3]))
        }
    }

    /// Selection box and the in-progress gesture.
    @ViewBuilder
    private func annotationLayer(_ transform: PdfViewTransform) -> some View {
        if let selected = selectedAnnotation,
           let annotation = annotations.first(where: { $0.base.index == selected }) {
            let box = transform.toView(annotation.base.rect)
            Rectangle()
                .stroke(Color.orange, lineWidth: 2)
                .frame(width: max(box.width, 8), height: max(box.height, 8))
                .offset(x: box.minX, y: box.minY)
        }

        if stroke.count > 1 {
            Path { $0.addLines(stroke) }
                .stroke(Color.blue, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        }

        if let rect = dragRect {
            Rectangle()
                .fill(Color.yellow.opacity(0.35))
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    /// A note is typed where it will live, not in a dialog.
    @ViewBuilder
    private func pendingNoteEditor(_ transform: PdfViewTransform) -> some View {
        if let point = pendingNote {
            let origin = transform.toView(point)
            HStack(spacing: 4) {
                TextField("Note", text: $noteDraft)
                    .font(.system(size: 13))
                    .textFieldStyle(.plain)
                    .focused($noteFocused)
                    .submitLabel(.done)
                    .onSubmit { Task { await commitNote() } }
                Button {
                    Task { await commitNote() }
                } label: {
                    Image(systemName: "checkmark.circle.fill")
                }
            }
            .padding(5)
            .frame(width: 190)
            .background(Color.yellow.opacity(0.9))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .shadow(radius: 2)
            .offset(x: origin.x, y: origin.y)
            .onAppear { noteFocused = true }
        }
    }

    // MARK: - Gestures

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
            // Field controls handle their own taps; this only hits bare page or annotations.
            focusedField = nil
            let point = transform.toPdf(gesture.location)
            selectedAnnotation = annotations.last(where: { $0.base.rect.contains(point) })?.base.index

        case .note:
            pendingNote = transform.toPdf(gesture.location)
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

    private func commitText(_ index: Int) async {
        guard let value = drafts[index],
              let page = try? await store.document?.page(pageIndex) else { return }
        drafts[index] = nil
        try? await page.setText(value, forFieldAt: index)
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
        guard let point = pendingNote else { return }
        pendingNote = nil
        noteFocused = false
        let text = noteDraft
        guard !text.isEmpty else { return }
        let rect = PdfRect(left: point.x, bottom: point.y - 24, right: point.x + 24, top: point.y)
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
        // No .forms: the live controls above draw the values instead.
        image = try? await page.render(width: 1400, options: [.annotations])
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 4) {
            Text(status ?? "\(tool.hint) · \(fields.count) field\(fields.count == 1 ? "" : "s") · \(annotations.count) annotation\(annotations.count == 1 ? "" : "s")")
                .font(.caption).foregroundColor(.secondary)
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

extension PdfFormField: Identifiable {
    public var id: Int { base.annotationIndex }
}

private extension CGRect {
    init(from a: CGPoint, to b: CGPoint) {
        self.init(x: min(a.x, b.x), y: min(a.y, b.y),
                  width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
}
