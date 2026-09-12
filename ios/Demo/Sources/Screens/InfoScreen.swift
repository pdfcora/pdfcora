import SwiftUI
import PdfiumKit

struct InfoScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var metadata: PdfMetadata?
    @State private var permissions: PdfPermissions = []
    @State private var attachments: [PdfAttachment] = []

    var body: some View {
        List {
            Section("Engine") {
                row("PDFium", PdfDocument.engineVersion)
                row("Pages", "\(store.pageCount)")
            }
            Section("Metadata") {
                if let metadata {
                    row("Title", metadata.title ?? "—")
                    row("Author", metadata.author ?? "—")
                    row("Subject", metadata.subject ?? "—")
                    row("Creator", metadata.creator ?? "—")
                    row("Producer", metadata.producer ?? "—")
                    row("Created", metadata.creationDate?.formatted() ?? "—")
                    row("Modified", metadata.modificationDate?.formatted() ?? "—")
                } else {
                    ProgressView()
                }
            }
            Section("Permissions") {
                permissionRow("Print", .print)
                permissionRow("Modify", .modify)
                permissionRow("Copy", .copy)
                permissionRow("Annotate", .annotate)
                permissionRow("Fill forms", .fillForms)
            }
            Section("Attachments") {
                if attachments.isEmpty {
                    Text("None").foregroundColor(.secondary)
                } else {
                    ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                        row(attachment.name, ByteCountFormatter.string(fromByteCount: Int64(attachment.byteCount), countStyle: .file))
                    }
                }
            }
        }
        .navigationTitle("Document Info")
        .task {
            guard let document = store.document else { return }
            metadata = try? await document.metadata
            permissions = await document.permissions
            attachments = (try? await document.attachments) ?? []
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundColor(.secondary).multilineTextAlignment(.trailing)
        }
    }

    private func permissionRow(_ label: String, _ permission: PdfPermissions) -> some View {
        HStack {
            Text(label)
            Spacer()
            Image(systemName: permissions.contains(permission) ? "checkmark.circle.fill" : "xmark.circle")
                .foregroundColor(permissions.contains(permission) ? .green : .secondary)
        }
    }
}
