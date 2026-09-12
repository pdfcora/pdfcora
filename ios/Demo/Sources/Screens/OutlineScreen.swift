import SwiftUI
import PdfiumKit

struct OutlineScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var outline: [PdfOutlineItem] = []
    @State private var loaded = false

    var body: some View {
        Group {
            if !loaded {
                ProgressView()
            } else if outline.isEmpty {
                ContentUnavailableCompat(text: "This document has no outline.")
            } else {
                List { OutlineRows(items: outline, depth: 0) }
            }
        }
        .navigationTitle("Outline")
        .task {
            guard let document = store.document else { return }
            outline = (try? await document.outline) ?? []
            loaded = true
        }
    }
}

private struct OutlineRows: View {
    let items: [PdfOutlineItem]
    let depth: Int

    var body: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            HStack {
                Text(item.title.isEmpty ? "(untitled)" : item.title)
                Spacer()
                if let page = item.pageIndex {
                    Text("p.\(page + 1)").font(.caption).foregroundColor(.secondary)
                }
            }
            .padding(.leading, CGFloat(depth) * 16)

            if !item.children.isEmpty {
                OutlineRows(items: item.children, depth: depth + 1)
            }
        }
    }
}
