import SwiftUI
import PDFCora
import PDFCoraUI

@main
struct ViewerApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

/// The viewer component with a hand-picked toolbar, an app accent colour and a save
/// handler. `PdfToolbarConfiguration.default` and `.viewing` are ready-made.
struct ContentView: View {
    @State private var document: PdfDocument?
    @State private var failure: String?
    @State private var saved: String?

    var body: some View {
        Group {
            if let document {
                PdfViewerView(
                    document: document,
                    toolbar: PdfToolbarConfiguration(items: [
                        .pageBack, .pageForward, .divider,
                        .tool(.highlight), .tool(.note), .divider,
                        .zoomOut, .fitWidth, .zoomIn, .spacer, .save,
                    ]),
                    theme: {
                        var theme = PdfViewerTheme.light
                        theme.accent = Color(red: 0.486, green: 0.227, blue: 0.929)
                        return theme
                    }(),
                    // The viewer never writes a file; it hands the app the bytes it saved.
                    onSave: { bytes in saved = "Saved \(bytes.count / 1024) KB" }
                )
                .safeAreaInset(edge: .bottom) {
                    if let saved { Text(saved).font(.caption).padding(6) }
                }
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
