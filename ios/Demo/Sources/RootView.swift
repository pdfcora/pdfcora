import SwiftUI
import UniformTypeIdentifiers

/// Every screen the demo offers. Each one is a self-contained example of one API area.
enum Demo: String, CaseIterable, Identifiable {
    case editor = "Editor"
    case viewer = "Viewer"
    case search = "Search"
    case outline = "Outline"
    case thumbnails = "Thumbnails"
    case annotations = "Annotations"
    case forms = "Forms"
    case text = "Text"
    case signatures = "Signatures"
    case info = "Document Info"
    case pageOps = "Page Operations"
    case export = "Export"
    case ai = "AI"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .editor: "pencil.and.outline"
        case .viewer: "doc.richtext"
        case .search: "magnifyingglass"
        case .outline: "list.bullet.indent"
        case .thumbnails: "square.grid.2x2"
        case .annotations: "pencil.tip.crop.circle"
        case .forms: "checkmark.square"
        case .text: "text.quote"
        case .signatures: "signature"
        case .info: "info.circle"
        case .pageOps: "rotate.right"
        case .export: "square.and.arrow.up"
        case .ai: "sparkles"
        }
    }

    var detail: String {
        switch self {
        case .editor: "Fill forms and annotate"
        case .viewer: "Render pages, pan and zoom"
        case .search: "Find text and highlight hits"
        case .outline: "Bookmarks and destinations"
        case .thumbnails: "Grid of rendered pages"
        case .annotations: "Read, draw ink, add notes"
        case .forms: "Fill fields, toggle checkboxes"
        case .text: "Extract and copy page text"
        case .signatures: "Read signatures and their coverage"
        case .info: "Metadata, permissions, attachments"
        case .pageOps: "Rotate pages"
        case .export: "Save edits and share"
        case .ai: "On-device availability and providers"
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var showingPicker = false
    @State private var openInEditor = false

    var body: some View {
        NavigationView {
            List {
                Section("Document") {
                    ForEach(DocumentStore.samples) { sample in
                        Button {
                            Task { await store.load(sample) }
                        } label: {
                            HStack {
                                Text(sample.title)
                                Spacer()
                                if store.title == sample.title {
                                    Image(systemName: "checkmark").foregroundColor(.accentColor)
                                }
                            }
                        }
                        .accessibilityIdentifier("sample-\(sample.title)")
                    }
                    Button("Open a file…") { showingPicker = true }
                }

                if let error = store.error {
                    Section { Text(error).foregroundColor(.red).font(.callout) }
                }

                Section("\(store.title) — \(store.pageCount) page\(store.pageCount == 1 ? "" : "s")") {
                    ForEach(Demo.allCases) { demo in
                        NavigationLink {
                            screen(for: demo)
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(demo.rawValue)
                                    Text(demo.detail).font(.caption).foregroundColor(.secondary)
                                }
                            } icon: {
                                Image(systemName: demo.icon)
                            }
                        }
                        .accessibilityIdentifier("demo-\(demo.rawValue)")
                        .disabled(store.document == nil)
                    }
                }
            }
            .navigationTitle("PdfiumKit")
            .task { if store.document == nil { await store.load(DocumentStore.samples[0]) } }
            .fileImporter(isPresented: $showingPicker, allowedContentTypes: [.pdf]) { result in
                if case .success(let url) = result {
                    // An opened file goes straight to the editor: that is where a form
                    // can actually be filled in.
                    Task {
                        await store.load(url: url, title: url.lastPathComponent)
                        if store.document != nil { openInEditor = true }
                    }
                }
            }
            .background(
                NavigationLink(isActive: $openInEditor) { EditorScreen() } label: { EmptyView() }
                    .hidden()
            )
        }
        .navigationViewStyle(.stack)
    }

    @ViewBuilder
    private func screen(for demo: Demo) -> some View {
        switch demo {
        case .editor:      EditorScreen()
        case .viewer:      ViewerScreen()
        case .search:      SearchScreen()
        case .outline:     OutlineScreen()
        case .thumbnails:  ThumbnailsScreen()
        case .annotations: AnnotationsScreen()
        case .forms:       FormsScreen()
        case .text:        TextScreen()
        case .signatures:  SignaturesScreen()
        case .info:        InfoScreen()
        case .pageOps:     PageOpsScreen()
        case .export:      ExportScreen()
        case .ai:          AIScreen()
        }
    }
}
