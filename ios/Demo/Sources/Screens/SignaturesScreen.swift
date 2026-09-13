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
    /// Two independent answers per signature, keyed by index.
    @State private var verdicts: [Int: (intact: Bool, trust: PdfSignatureValidity)] = [:]
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

                    if let verdict = verdicts[signature.index] {
                        verification(verdict)
                    }
                }
            }

            if !signatures.isEmpty {
                Section {
                    Text("Revocation is not checked, so a valid result does not mean the "
                         + "certificate is still in good standing.")
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

    /// Shown as two rows so neither answer can be mistaken for the other: a signature
    /// can be cryptographically intact and still untrusted.
    @ViewBuilder
    private func verification(_ verdict: (intact: Bool, trust: PdfSignatureValidity)) -> some View {
        let trusted: Bool = { if case .valid = verdict.trust { return true }; return false }()

        Label(verdict.intact
                ? "Integrity: the signed bytes are unchanged."
                : "Integrity: FAILED.",
              systemImage: verdict.intact ? "checkmark.seal" : "xmark.seal.fill")
            .foregroundColor(verdict.intact ? .green : .red)
            .accessibilityIdentifier(verdict.intact ? "integrity-ok" : "integrity-failed")

        Label(trusted
                ? "Trust: the chain reaches a trusted issuer."
                : "Trust: not established — \(reason(verdict.trust)).",
              systemImage: trusted ? "checkmark.shield" : "exclamationmark.shield")
            .foregroundColor(trusted ? .green : .orange)
            .accessibilityIdentifier(trusted ? "trust-ok" : "trust-unestablished")
    }

    private func reason(_ verdict: PdfSignatureValidity) -> String {
        switch verdict {
        case .untrusted(_, let reason): return reason
        case .digestMismatch: return "the bytes changed after signing"
        case .expired(let at): return "the certificate expired on \(at)"
        case .malformed(let reason): return reason
        case .unsupported(let subFilter): return "unsupported type \(subFilter)"
        case .valid: return ""
        }
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

            // Two deliberately separate questions. Verifying without anchors answers
            // trust and, when it fails, hands back the chain; re-verifying with that
            // chain's own root as an anchor then isolates the cryptography.
            var found: [Int: (intact: Bool, trust: PdfSignatureValidity)] = [:]
            for signature in signatures {
                let trust = await document.verify(signature)
                let intact: Bool
                switch trust {
                case .valid:
                    intact = true
                case .untrusted(let chain, _):
                    let anchored = await document.verify(
                        signature,
                        options: PdfVerifyOptions(trustAnchors: chain.last.map { [$0.der] } ?? []))
                    if case .valid = anchored { intact = true } else { intact = false }
                default:
                    intact = false
                }
                found[signature.index] = (intact, trust)
            }
            verdicts = found
        } catch let failure as PdfError {
            error = failure.description
        } catch {
            self.error = error.localizedDescription
        }
    }
}
