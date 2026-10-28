import XCTest
@testable import PDFCora
@testable import PDFCoraAI

/// How much personal data Apple's on-device model adds on the shared document, per language.
/// Opt-in: `TEST_RUNNER_PDFCORA_MEASURE_APPLE=1` in the environment of `xcodebuild test`.
final class RedactionMeasurementTests: XCTestCase {
    func testAppleModelOnThePiiDocument() async throws {
        guard ProcessInfo.processInfo.environment["PDFCORA_MEASURE_APPLE"] == "1" else {
            throw XCTSkip("set TEST_RUNNER_PDFCORA_MEASURE_APPLE=1")
        }
        let url = RedactionPatternTests.root.appendingPathComponent("conformance/redaction/pii.pdf")
        let document = try await PdfDocument(data: try Data(contentsOf: url))
        let wanted: [Int: [(PdfRedactionCategory, String)]] = [
            0: [(.personName, "Anna Schmidt"), (.postalAddress, "221B Baker Street, London NW1 6XE"), (.idNumber, "502135326")],
            1: [(.personName, "Jonas Müller"), (.postalAddress, "Hauptstraße 12, 10115 Berlin"), (.idNumber, "L01X00T47"), (.idNumber, "65929970489")],
        ]
        // The first readings after launch report no prompt budget, which the SDK treats as
        // not promptable. One call wakes the model.
        _ = try? await AppleModel.respond(to: "Reply with OK.")
        for page in [0, 1] {
            let started = Date()
            let review = try await PdfAI(document: document).redactions.suggest(pages: page...page, categories: Set(PdfRedactionCategory.model))
            let found = review.suggestions.filter { $0.source == .onDevice }
            let hits = wanted[page]!.filter { want in found.contains { $0.category == want.0 && $0.text.contains(want.1) } }
            print("MEASURE page \(page) \(page == 0 ? "English" : "German"): modelUsed=\(review.modelUsed) found \(hits.count) of \(wanted[page]!.count) in \(String(format: "%.1f", Date().timeIntervalSince(started))) s; suggestions: \(found.map { "\($0.category.rawValue)=\($0.text)" })")
        }
    }
}
