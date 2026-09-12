import SwiftUI
import PdfiumKit

struct ViewerScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var pageIndex = 0
    @State private var image: UIImage?
    @State private var zoom: CGFloat = 1

    var body: some View {
        VStack(spacing: 0) {
            ScrollView([.horizontal, .vertical]) {
                if let image {
                    Image(uiImage: image)
                        .resizable().scaledToFit()
                        .frame(width: 900 * zoom)
                        .padding()
                } else {
                    ProgressView().padding(40)
                }
            }
            controls
        }
        .navigationTitle("Viewer")
        .task(id: pageIndex) { await render() }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack {
                Button { pageIndex = max(0, pageIndex - 1) } label: { Image(systemName: "chevron.left") }
                    .disabled(pageIndex == 0)
                Spacer()
                Text("Page \(pageIndex + 1) of \(store.pageCount)").font(.callout.monospacedDigit())
                Spacer()
                Button { pageIndex = min(store.pageCount - 1, pageIndex + 1) } label: { Image(systemName: "chevron.right") }
                    .disabled(pageIndex >= store.pageCount - 1)
            }
            HStack {
                Image(systemName: "minus.magnifyingglass")
                Slider(value: $zoom, in: 0.5...3)
                Image(systemName: "plus.magnifyingglass")
            }
        }
        .padding()
        .background(.bar)
    }

    private func render() async {
        guard let document = store.document else { return }
        image = try? await document.page(pageIndex).render(width: 900)
    }
}
