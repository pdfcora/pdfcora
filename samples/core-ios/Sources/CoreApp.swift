import SwiftUI
import PdfiumKit

@main
struct CoreApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

/// The core API with no UI component: open a PDF, read its facts, get page text, search,
/// list form fields, render a page, save.
struct ContentView: View {
    @State private var facts: [String] = []
    @State private var text = ""
    @State private var page: UIImage?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(facts, id: \.self) { Text($0).font(.callout) }
                Text("Page 1 text").font(.headline).padding(.top)
                Text(text).font(.caption)
                if let page {
                    Text("Page 1 rendered").font(.headline).padding(.top)
                    Image(uiImage: page).resizable().scaledToFit()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .task { await load() }
    }

    private func load() async {
        guard let url = Bundle.main.url(forResource: "sample", withExtension: "pdf") else {
            facts = ["sample.pdf is missing from the app bundle"]
            return
        }
        do {
            // The document is an actor: every call below runs off the main thread.
            let document = try await PdfDocument(url: url)
            let first = try document.page(0)
            facts = [
                "Pages: \(document.pageCount)",
                "Title: \(document.metadata.title ?? "(none)")",
                "Signatures: \(try document.signatures().count)",
                "Matches for \"the\" on page 1: \(try await first.text.search("the").count)",
                "Form fields on page 1: \(try await first.formFields().count)",
                "Saved size: \(try document.data().count) bytes",
            ]
            text = String((try await first.text.string()).prefix(600))
            page = try await first.render(width: 900)
            // The document holds native memory; an app closes it when done with it.
            document.close()
        } catch {
            facts = ["Could not read the PDF: \(error)"]
        }
    }
}
