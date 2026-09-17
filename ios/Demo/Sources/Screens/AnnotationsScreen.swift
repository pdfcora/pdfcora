import SwiftUI
import PDFCora

struct AnnotationsScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var annotations: [PdfAnnotation] = []
    @State private var image: UIImage?
    @State private var status: String?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().padding()
                }
                annotationList
            }
            actions
        }
        .navigationTitle("Annotations")
        .task { await reload() }
    }

    private var annotationList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(annotations.count) annotation\(annotations.count == 1 ? "" : "s") on page 1")
                .font(.headline)
            ForEach(Array(annotations.enumerated()), id: \.offset) { _, annotation in
                HStack(alignment: .top) {
                    Text(label(for: annotation)).font(.callout.monospaced())
                    Spacer()
                    if let contents = annotation.base.contents, !contents.isEmpty {
                        Text(contents).font(.caption).foregroundColor(.secondary)
                            .lineLimit(2).multilineTextAlignment(.trailing)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
    }

    private var actions: some View {
        VStack(spacing: 8) {
            if let status { Text(status).font(.caption).foregroundColor(.secondary) }
            HStack {
                Button("Add ink") { Task { await addInk() } }
                Button("Add note") { Task { await addNote() } }
                Button("Remove last", role: .destructive) { Task { await removeLast() } }
                    .disabled(annotations.isEmpty)
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .background(.bar)
    }

    /// Exhaustive matching — adding a case to PdfAnnotation would surface here at compile time.
    private func label(for annotation: PdfAnnotation) -> String {
        switch annotation {
        case .highlight(let a): "highlight (\(a.quads.count) quads)"
        case .underline:  "underline"
        case .strikeout:  "strikeout"
        case .squiggly:   "squiggly"
        case .ink(let a): "ink (\(a.strokes.count) strokes)"
        case .freeText(let a): "freeText (size \(a.fontSize.map { String(format: "%.0f", $0) } ?? "?"))"
        case .square:     "square"
        case .circle:     "circle"
        case .line:       "line"
        case .text:       "note"
        case .link(let a): "link \(a.uri ?? "")"
        case .stamp:      "stamp"
        case .fileAttachment: "fileAttachment"
        case .widget(let a): "widget \(a.fieldName ?? "")"
        case .unknown(let a): "unknown (subtype \(a.subtypeCode))"
        }
    }

    private func addInk() async {
        guard let page = try? await store.document?.page(0) else { return }
        let stroke = (0...20).map { i -> PdfPoint in
            let t = Double(i) / 20
            return PdfPoint(x: 40 + t * 120, y: 90 + sin(t * .pi * 2) * 25)
        }
        try? await page.addInk(strokes: [stroke], color: PdfColor(red: 0, green: 90, blue: 220), lineWidth: 2)
        status = "Added an ink stroke"
        await reload()
    }

    private func addNote() async {
        guard let page = try? await store.document?.page(0) else { return }
        try? await page.addNote(rect: PdfRect(left: 30, bottom: 30, right: 60, top: 60),
                                contents: "Added from the demo at \(Date().formatted(date: .omitted, time: .standard))")
        status = "Added a note"
        await reload()
    }

    private func removeLast() async {
        guard let page = try? await store.document?.page(0), !annotations.isEmpty else { return }
        try? await page.removeAnnotation(at: annotations.count - 1)
        status = "Removed the last annotation"
        await reload()
    }

    private func reload() async {
        guard let document = store.document, let page = try? await document.page(0) else { return }
        annotations = (try? await page.annotations()) ?? []
        image = try? await page.render(width: 700, options: .annotations)
    }
}
