import SwiftUI
import PDFCora
import PDFCoraAI

@main
struct AIApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

/// Summarise a document with Apple's on-device model, and propose redactions a person
/// accepts before anything is changed.
struct ContentView: View {
    @State private var ai: PdfAI?
    @State private var availability = "…"
    @State private var summary = ""
    @State private var review: PdfRedactionReview?
    @State private var accepted: Set<String> = []
    @State private var applied = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(availability).font(.caption)

                Button("Summarise") { Task { await summarise() } }
                if !summary.isEmpty { Text(summary).font(.caption) }

                Button("Find personal data") { Task { await suggest() } }
                if let review {
                    // RED-4: the notice goes with the suggestions, every time.
                    Text(review.notice).font(.caption).padding(.vertical, 4)
                    ForEach(review.suggestions, id: \.id) { suggestion in
                        Toggle(isOn: Binding(
                            get: { accepted.contains(suggestion.id) },
                            set: { on in if on { accepted.insert(suggestion.id) } else { accepted.remove(suggestion.id) } }
                        )) {
                            Text("\(suggestion.category.rawValue): \(suggestion.text)").font(.caption)
                        }
                    }
                    Button("Redact the ticked items") { Task { await apply(review) } }
                    if !applied.isEmpty { Text(applied).font(.caption) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .task { await load() }
    }

    private func load() async {
        guard let url = Bundle.main.url(forResource: "sample", withExtension: "pdf"),
              let document = try? await PdfDocument(url: url) else {
            availability = "sample.pdf is missing from the app bundle"
            return
        }
        // No provider is configured, so the SDK uses Apple's on-device model where the
        // device has it, and its own patterns otherwise. An app with a hosted model
        // passes `PdfAIOptions(provider:)`; text reaches it only because it did.
        let engine = PdfAI(document: document)
        ai = engine
        // AVL-2: availability is reported per feature and re-read on every call.
        availability = "Summaries: \(engine.summaries.availability())"
    }

    private func summarise() async {
        guard let ai else { return }
        summary = "Working…"
        switch await ai.summaries.summarize(style: .keyPoints) {
        case .answered(let result): summary = "\(result.value.text)\n\n— \(result.source)"
        case .unavailable(let state): summary = "No summary: \(state)"
        }
    }

    private func suggest() async {
        guard let ai, let found = try? await ai.redactions.suggest() else { return }
        accepted = Set(found.suggestions.map(\.id))
        review = found
    }

    private func apply(_ review: PdfRedactionReview) async {
        guard let result = try? await review.apply(accepting: Array(accepted)) else { return }
        // Redaction removes the content itself: this is about the saved bytes, not a
        // black box drawn over the page. `undo()` puts the document back.
        applied = "Removed \(result.report.textObjects), rewrote \(result.report.textObjectsSplit); "
            + "still findable: \(result.remaining.count)"
    }
}
