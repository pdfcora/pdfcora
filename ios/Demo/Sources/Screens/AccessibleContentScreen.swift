import SwiftUI
import PdfiumKit
import PdfiumKitUI

/// A tagged document in the component, for VoiceOver: headings, paragraphs and figures by
/// their alternate text, in reading order.
struct AccessibleContentScreen: View {
    @State private var document: PdfDocument?

    var body: some View {
        Group {
            if let document { PdfViewerView(document: document) } else { ProgressView() }
        }
        .navigationTitle("Accessible content")
        .task {
            guard let url = Bundle.main.url(forResource: "tagged", withExtension: "pdf") else { return }
            document = try? await PdfDocument(url: url)
        }
    }
}
