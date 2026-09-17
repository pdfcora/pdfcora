import SwiftUI
import PDFCora

struct SearchScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var query = ""
    @State private var caseSensitive = false
    @State private var hits: [(page: Int, match: PdfTextMatch)] = []
    @State private var searching = false

    var body: some View {
        VStack {
            HStack {
                TextField("Search the document", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .onSubmit { Task { await search() } }
                Button("Find") { Task { await search() } }.disabled(query.isEmpty)
            }
            Toggle("Case sensitive", isOn: $caseSensitive).font(.callout)

            if searching {
                ProgressView().padding()
            } else if hits.isEmpty {
                ContentUnavailableCompat(text: query.isEmpty ? "Enter a term to search."
                                                             : "No matches for “\(query)”.")
            } else {
                List(Array(hits.enumerated()), id: \.offset) { _, hit in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Page \(hit.page + 1)").font(.headline)
                        Text("characters \(hit.match.range.lowerBound)–\(hit.match.range.upperBound), \(hit.match.rects.count) rect\(hit.match.rects.count == 1 ? "" : "s")")
                            .font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            Spacer()
        }
        .padding()
        .navigationTitle("Search")
    }

    private func search() async {
        guard let document = store.document else { return }
        searching = true
        defer { searching = false }

        var found: [(Int, PdfTextMatch)] = []
        let options: PdfSearchOptions = caseSensitive ? .caseSensitive : .none
        for index in 0..<store.pageCount {
            guard let page = try? await document.page(index),
                  let matches = try? await page.text.search(query, options: options) else { continue }
            found.append(contentsOf: matches.map { (index, $0) })
        }
        hits = found
    }
}

/// `ContentUnavailableView` needs iOS 17; the demo targets 15.
struct ContentUnavailableCompat: View {
    let text: String
    var body: some View {
        Text(text).foregroundColor(.secondary).padding(.vertical, 40)
    }
}
