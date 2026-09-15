import SwiftUI
import PdfiumKit
import PdfiumKitUI
import PdfiumKitAI

/// Smart form filling reviewed in the component: a fixed demo profile, synonyms only, so it
/// runs anywhere.
struct FormFillingScreen: View {
    @State private var document: PdfDocument?
    @State private var proposals: PdfFormProposals?
    @State private var result: String?

    private static let profile: [PdfProfileKey: String] = [
        .givenName: "Anna", .familyName: "Schmidt", .fullName: "Anna Schmidt", .dateOfBirth: "1985-03-14",
        .email: "anna.schmidt@example.com", .phone: "+44 20 7946 0958", .street: "221B Baker Street", .postalCode: "NW1 6XE",
        .city: "London", .country: "United Kingdom", .iban: "GB29 NWBK 6016 1331 9268 19", .company: "Example Holdings Ltd",
    ]

    var body: some View {
        VStack {
            if let result { Text(result).accessibilityIdentifier("form-result") }
            if let document, let proposals {
                PdfViewerView(document: document, review: PdfReviewConfiguration(
                    marks: proposals.items.map { PdfMark(id: $0.id, pageIndex: $0.pageIndex, rects: [$0.rect], label: Self.label($0.value)) },
                    notice: proposals.notice, applyLabel: "Fill in",
                    onApply: { ids in Task {
                        _ = try await proposals.apply(accepting: ids)
                        result = "Filled \(ids.count) fields"
                    } }))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Form filling")
        .task {
            guard let url = Bundle.main.url(forResource: "forms", withExtension: "pdf"),
                  let opened = try? await PdfDocument(url: url) else { return }
            document = opened
            proposals = try? await PdfiumAI(document: opened).forms.propose(profile: Self.profile)
        }
    }

    private static func label(_ value: PdfFormValue) -> String {
        switch value {
        case .text(let text): text
        case .option: "option"
        case .checked: "✓"
        }
    }
}
