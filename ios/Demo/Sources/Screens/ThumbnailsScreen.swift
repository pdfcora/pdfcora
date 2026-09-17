import SwiftUI
import PDFCora

struct ThumbnailsScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var thumbnails: [Int: UIImage] = [:]

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 16)]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(0..<store.pageCount, id: \.self) { index in
                    VStack(spacing: 4) {
                        Group {
                            if let image = thumbnails[index] {
                                Image(uiImage: image).resizable().scaledToFit()
                            } else {
                                Rectangle().fill(.quaternary).aspectRatio(0.7, contentMode: .fit)
                                    .overlay(ProgressView())
                            }
                        }
                        .border(.quaternary)
                        Text("\(index + 1)").font(.caption)
                    }
                    .task { await thumbnail(index) }
                }
            }
            .padding()
        }
        .navigationTitle("Thumbnails")
    }

    private func thumbnail(_ index: Int) async {
        guard thumbnails[index] == nil, let document = store.document else { return }
        guard let page = try? await document.page(index),
              let image = try? await page.render(width: 160, options: .annotations) else { return }
        thumbnails[index] = image
    }
}
