import SwiftUI
import PDFCora

struct PageOpsScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var pageIndex = 0
    @State private var image: UIImage?
    @State private var rotation: PdfPageRotation = .none
    @State private var size: PdfSize?

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().padding()
                } else {
                    ProgressView().padding(40)
                }
                if let size {
                    Text(String(format: "%.0f × %.0f pt · rotation %d°",
                                size.width, size.height, rotation.rawValue * 90))
                        .font(.caption).foregroundColor(.secondary)
                }
            }
            HStack {
                Button { pageIndex = max(0, pageIndex - 1) } label: { Image(systemName: "chevron.left") }
                    .disabled(pageIndex == 0)
                Spacer()
                Button { Task { await rotate(by: -1) } } label: { Image(systemName: "rotate.left") }
                Button { Task { await rotate(by: 1) } } label: { Image(systemName: "rotate.right") }
                Spacer()
                Button { pageIndex = min(store.pageCount - 1, pageIndex + 1) } label: { Image(systemName: "chevron.right") }
                    .disabled(pageIndex >= store.pageCount - 1)
            }
            .padding()
            .background(.bar)
        }
        .navigationTitle("Page Operations")
        .task(id: pageIndex) { await reload() }
    }

    private func rotate(by steps: Int) async {
        guard let page = try? await store.document?.page(pageIndex) else { return }
        let next = PdfPageRotation(rawValue: ((rotation.rawValue + steps) % 4 + 4) % 4) ?? .none
        try? await page.setRotation(next)
        await reload()
    }

    private func reload() async {
        guard let page = try? await store.document?.page(pageIndex) else { return }
        rotation = (try? await page.rotation) ?? .none
        size = try? await page.size
        image = try? await page.render(width: 600)
    }
}
