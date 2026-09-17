import SwiftUI
import PDFCora
import PDFCoraUI

/// The same editor as `EditorScreen`, built from the SDK's own component instead of by
/// hand — which is the point of the component existing.
///
/// `EditorScreen` is kept alongside it deliberately: it is the worked example of driving
/// the headless `PdfViewer` yourself, and it is what proves the two layers are really
/// separable.
struct ComponentScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var savedSize: String?
    /// For the UI test of the component's error path, launched with
    /// `-component-closed-document`: a document closed before it is shown.
    @State private var closedDocument: PdfDocument?
    private let showsClosedDocument = ProcessInfo.processInfo.arguments.contains("-component-closed-document")

    /// A custom toolbar item, to show that an app can add its own. Content is
    /// platform-native on purpose: this is an SF Symbol.
    private var toolbar: PdfToolbarConfiguration {
        var configuration = PdfToolbarConfiguration.default
        configuration.items.append(.custom(id: "custom-share", label: "Share",
                                           systemImage: "square.and.arrow.up") {
            // An app-defined action. The component knows nothing about it.
        })
        return configuration
    }

    var body: some View {
        Group {
            if showsClosedDocument {
                // A placeholder, not nothing: SwiftUI never starts .task on an empty view.
                if let closedDocument { PdfViewerView(document: closedDocument, toolbar: toolbar) } else { ProgressView() }
            } else if let document = store.document {
                PdfViewerView(document: document, toolbar: toolbar, theme: .light) { data in
                    savedSize = ByteCountFormatter.string(fromByteCount: Int64(data.count),
                                                          countStyle: .file)
                }
            } else {
                Text("No document loaded.").foregroundColor(.secondary)
            }
        }
        .task {
            guard showsClosedDocument, let url = Bundle.main.url(forResource: "sample", withExtension: "pdf"),
                  let document = try? await PdfDocument(url: url) else { return }
            await document.close()
            closedDocument = document
        }
        .navigationTitle("Component")
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) {
            if let savedSize {
                Text("Saved \(savedSize)").font(.caption).padding(6)
            }
        }
    }
}
