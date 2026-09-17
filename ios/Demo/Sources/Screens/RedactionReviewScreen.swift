import SwiftUI
import PDFCora
import PDFCoraUI
import PDFCoraAI

/// Redaction suggestions reviewed in the component: patterns only, so it runs anywhere.
struct RedactionReviewScreen: View {
    @State private var document: PdfDocument?
    @State private var review: PdfRedactionReview?
    @State private var result: String?

    var body: some View {
        VStack {
            if let result { Text(result).accessibilityIdentifier("redaction-result") }
            if let document, let review {
                PdfViewerView(document: document, review: PdfReviewConfiguration(
                    marks: review.suggestions.map { PdfMark(id: $0.id, pageIndex: $0.pageIndex, rects: $0.rects) },
                    notice: review.notice, applyLabel: "Redact",
                    onApply: { ids in Task {
                        let applied = try await review.apply(accepting: ids)
                        result = "Redacted \(ids.count), \(applied.remaining.count) remaining"
                    } }))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Redaction review")
        .task {
            guard let url = Bundle.main.url(forResource: "pii", withExtension: "pdf"),
                  let opened = try? await PdfDocument(url: url) else { return }
            document = opened
            review = try? await PdfAI(document: opened).redactions.suggest(categories: Set(PdfRedactionCategory.patterns))
        }
    }
}
