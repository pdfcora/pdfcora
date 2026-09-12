import SwiftUI
import PdfiumKit

struct TextScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var pageIndex = 0
    @State private var text = ""
    @State private var characterCount = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                Text(text.isEmpty ? "This page has no extractable text." : text)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            HStack {
                Button { pageIndex = max(0, pageIndex - 1) } label: { Image(systemName: "chevron.left") }
                    .disabled(pageIndex == 0)
                Spacer()
                Text("Page \(pageIndex + 1) — \(characterCount) chars").font(.caption.monospacedDigit())
                Spacer()
                Button { UIPasteboard.general.string = text } label: { Image(systemName: "doc.on.doc") }
                    .disabled(text.isEmpty)
                Button { pageIndex = min(store.pageCount - 1, pageIndex + 1) } label: { Image(systemName: "chevron.right") }
                    .disabled(pageIndex >= store.pageCount - 1)
            }
            .padding()
            .background(.bar)
        }
        .navigationTitle("Text")
        .task(id: pageIndex) {
            guard let page = try? await store.document?.page(pageIndex) else { return }
            text = (try? await page.text.string()) ?? ""
            characterCount = (try? await page.text.characterCount) ?? 0
        }
    }
}
