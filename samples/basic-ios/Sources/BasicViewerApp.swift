import SwiftUI
import PdfiumKit
import PdfiumKitUI

@main
struct BasicViewerApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

/// Opens the bundled PDF and shows it in the SDK's viewer with its default toolbar.
struct ContentView: View {
    @State private var document: PdfDocument?
    @State private var failure: String?

    var body: some View {
        Group {
            if let document {
                PdfViewerView(document: document)
            } else if let failure {
                Text(failure)
            } else {
                ProgressView()
            }
        }
        .task {
            guard let url = Bundle.main.url(forResource: "sample", withExtension: "pdf") else {
                failure = "sample.pdf is missing from the app bundle"
                return
            }
            do {
                document = try await PdfDocument(url: url)
            } catch {
                failure = "Could not open the PDF: \(error)"
            }
        }
    }
}
