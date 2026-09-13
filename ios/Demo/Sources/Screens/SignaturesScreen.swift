import SwiftUI
import PdfiumKit

/// Lists the signatures a document carries.
///
/// The coverage banner is deliberately prominent. A signature can be cryptographically
/// intact and still cover only part of the file; presenting "signed" without that
/// distinction is how an amended document passes review.
struct SignaturesScreen: View {
    @EnvironmentObject private var store: DocumentStore

    @State private var signatures: [PdfSignature] = []
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).foregroundColor(.red)
            } else if signatures.isEmpty {
                Text("This document carries no signatures.").foregroundColor(.secondary)
            }

            ForEach(signatures, id: \.index) { signature in
                Section("Signature \(signature.index + 1)") {
                    coverage(signature)
                    row("Type", signature.subFilter ?? "—")
                    row("Reason", signature.reason ?? "—")
                    row("Claimed signing time", Self.formatted(signature.signingTime))
                    row("Signed ranges", signature.byteRange.map(String.init).joined(separator: ", "))
                    row("PKCS#7 size", "\(signature.contents.count) bytes")
                }
            }

            if !signatures.isEmpty {
                Section {
                    Text("Not verified. This SDK reads signatures; it does not yet check "
                         + "them cryptographically or validate the certificate chain.")
                        .font(.caption).foregroundColor(.secondary)
                }
            }
        }
        .navigationTitle("Signatures")
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
    }

    @ViewBuilder
    private func coverage(_ signature: PdfSignature) -> some View {
        let whole = signature.coversWholeDocument
        Label(
            whole
                ? "Covers the whole file."
                : "Covers only part of the file — content was added after signing and is NOT protected.",
            systemImage: whole ? "checkmark.seal" : "exclamationmark.triangle.fill"
        )
        .foregroundColor(whole ? .green : .orange)
        .accessibilityIdentifier(whole ? "coverage-whole" : "coverage-partial")
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundColor(.secondary)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.callout)
    }

    private static func formatted(_ date: Date?) -> String {
        guard let date else { return "—" }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date) + " UTC"
    }

    private func reload() async {
        guard let document = store.document else { return }
        do {
            signatures = try await document.signatures()
            error = nil
        } catch let failure as PdfError {
            error = failure.description
        } catch {
            self.error = error.localizedDescription
        }
    }
}
