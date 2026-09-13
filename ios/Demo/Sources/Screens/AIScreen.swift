import SwiftUI
import PdfiumKit
import PdfiumKitAI

/// What a user sees when a feature cannot run — which on most devices today is what they
/// will see.
///
/// The stub feature exists precisely so this path can be exercised before any real
/// feature does.
struct AIScreen: View {
    @EnvironmentObject private var store: DocumentStore

    @State private var endpoint = ""
    @State private var reading = AppleModel.read()
    @State private var status: String?

    /// A provider is the integrator's to supply. Document content reaches it only
    /// because the host configured it (PRV-4).
    private struct HttpProvider: PdfAiProvider {
        let url: URL

        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            var post = URLRequest(url: url)
            post.httpMethod = "POST"
            post.setValue("application/json", forHTTPHeaderField: "Content-Type")
            post.httpBody = try JSONSerialization.data(withJSONObject: ["prompt": request.prompt])

            let (data, response) = try await URLSession.shared.data(for: post)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return PdfAiResponse(text: json?["text"] as? String ?? "")
        }
    }

    private var provider: PdfAiProvider? {
        guard let url = URL(string: endpoint), !endpoint.isEmpty else { return nil }
        return HttpProvider(url: url)
    }

    var body: some View {
        Form {
            Section("On-device model") {
                row("Availability", describe(reading.availability))
                row("Prompt budget", reading.contextTokens.map(String.init) ?? "none")
                row("Promptable", reading.isPromptable ? "yes" : "no")

                Text("Availability alone is not enough. A simulator reports available with "
                     + "a budget of zero, and a feature that trusted availability would build "
                     + "an empty prompt. Both are read together, per call.")
                    .font(.caption).foregroundColor(.secondary)
            }

            Section("Images") {
                row("Accepts images", AppleModel.acceptsImages ? "yes" : "no")
                Text("FoundationModels is text-only as of iOS 26.4, so alt text has no "
                     + "on-device route on Apple platforms and falls back to a provider, "
                     + "as it does on the web.")
                    .font(.caption).foregroundColor(.secondary)
            }

            Section("Custom provider") {
                TextField("https://your-server/generate", text: $endpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("ai-endpoint")

                Text("The SDK ships no model and no cloud account.")
                    .font(.caption).foregroundColor(.secondary)
            }

            Section("Stub feature") {
                Button("Prepare") {
                    Task {
                        // AVL-4: the host asks. Nothing here starts a download on its own.
                        guard let ai else { return }
                        let after = await ai.stub.prepare { fraction in
                            Task { @MainActor in status = "preparing… \(Int(fraction * 100))%" }
                        }
                        status = "prepare finished — \(describe(after))"
                    }
                }
                .accessibilityIdentifier("ai-prepare")

                Button("Run") {
                    Task {
                        guard let ai else { return }
                        switch await ai.stub.run() {
                        case .answered(let result):
                            status = "answered \"\(result.value)\" via \(result.source)"
                        case .unavailable(let state):
                            status = "unavailable — \(describe(state))"
                        }
                    }
                }
                .accessibilityIdentifier("ai-run")

                if let status {
                    Text(status).font(.footnote).foregroundColor(.secondary)
                }

                Text("Phase 0 ships no AI feature. The stub does nothing except report "
                     + "whether it could, which is what makes this screen testable.")
                    .font(.caption).foregroundColor(.secondary)
            }
        }
        .navigationTitle("AI")
        .navigationBarTitleDisplayMode(.inline)
        // AVL-3: re-read on every appearance rather than caching at launch.
        .onAppear { reading = AppleModel.read() }
    }

    private var ai: PdfiumAI? {
        store.document.map { PdfiumAI(document: $0, options: .init(provider: provider)) }
    }

    /// `LabeledContent` is iOS 16+, and this demo holds the iOS 15 floor the package
    /// promises (PKG-3).
    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).foregroundColor(.secondary)
        }
    }

    private func describe(_ availability: PdfAiAvailability) -> String {
        switch availability {
        case .available: "available"
        case .downloadable: "downloadable"
        case .downloading(let progress):
            progress.map { "downloading \(Int($0 * 100))%" } ?? "downloading"
        case .unavailable(let reason): "unavailable — \(reason)"
        }
    }
}
