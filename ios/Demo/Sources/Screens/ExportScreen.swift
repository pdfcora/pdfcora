import SwiftUI
import PDFCora

struct ExportScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var exportedURL: URL?
    @State private var status = "Add an annotation or fill a form, then export."
    @State private var mode: PdfSaveMode = .full
    @State private var sharing = false

    var body: some View {
        Form {
            Section("Mode") {
                Picker("Save mode", selection: $mode) {
                    Text("Full rewrite").tag(PdfSaveMode.full)
                    Text("Incremental").tag(PdfSaveMode.incremental)
                }
                .pickerStyle(.segmented)

                if mode == .incremental {
                    Text("Incremental keeps the original bytes and existing signatures, but does not persist annotations created in this session.")
                        .font(.caption).foregroundColor(.secondary)
                }
            }
            Section {
                Button("Export") { Task { await export() } }
                if exportedURL != nil {
                    Button("Share…") { sharing = true }
                }
            }
            Section("Status") {
                Text(status).font(.callout).foregroundColor(.secondary)
            }
        }
        .navigationTitle("Export")
        .sheet(isPresented: $sharing) {
            if let exportedURL { ShareSheet(items: [exportedURL]) }
        }
    }

    private func export() async {
        guard let document = store.document else { return }
        do {
            let bytes = try await document.data(mode: mode)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("pdfcora-export.pdf")
            try bytes.write(to: url, options: .atomic)
            exportedURL = url
            status = "Exported \(ByteCountFormatter.string(fromByteCount: Int64(bytes.count), countStyle: .file)) to \(url.lastPathComponent)"
        } catch let error as PdfError {
            status = "Export failed — \(error.description)"
        } catch {
            status = "Export failed — \(error.localizedDescription)"
        }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
