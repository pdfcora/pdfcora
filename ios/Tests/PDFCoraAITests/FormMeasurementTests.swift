import XCTest
@testable import PDFCora
@testable import PDFCoraAI

/// How Apple's on-device model matches form fields, which is why forms do not use it. Opt-in:
/// `TEST_RUNNER_PDFCORA_MEASURE_APPLE=1` in the environment of `xcodebuild test`.
final class FormMeasurementTests: LicensedTestCase {
    func testAppleModelMatchingFields() async throws {
        guard ProcessInfo.processInfo.environment["PDFCORA_MEASURE_APPLE"] == "1" else {
            throw XCTSkip("set TEST_RUNNER_PDFCORA_MEASURE_APPLE=1")
        }
        // The first readings after launch report no prompt budget. One call wakes the model.
        _ = try? await AppleModel.respond(to: "Reply with OK.")
        let document = try await PdfDocument(data: try Data(contentsOf: FormTests.dir.appendingPathComponent("forms.pdf")))
        struct Expected: Decodable { let pageIndex: Int; let fieldName: String; let key: String }
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: FormTests.dir.appendingPathComponent("forms-expected.json")))
        let wanted = Dictionary(uniqueKeysWithValues: expected.map { ("\($0.pageIndex):\($0.fieldName)", $0.key) })

        let described = try await FieldDescriber.describe(document, pages: nil).filter { FormProposer.isFillable($0.field) }
        for page in [0, 1] {
            // Every field with its label removed: the model has only names and tooltips.
            let bare = described.filter { $0.pageIndex == page }.map { PdfFieldDescription(pageIndex: $0.pageIndex, field: $0.field, label: nil) }
            let started = Date()
            let reply = try await AppleModel.respond(to: FormProposer.prompt(bare)) ?? ""
            let answers = Dictionary(FormProposer.parse(reply).map { ($0.id, $0.key) }, uniquingKeysWith: { a, _ in a })
            var right = 0, wrong: [String] = []
            for f in bare {
                let name = f.base.name ?? ""
                let got = answers["\(f.pageIndex):\(f.base.annotationIndex)"] ?? "unknown"
                // With the label removed, a name that says nothing ("Text3", "Feld4") should be unknown.
                let meaningful = Synonyms.key(name: f.base.name, alternateName: f.base.alternateName, label: nil) != nil
                let want = meaningful ? (wanted["\(page):\(name)"] ?? "unknown") : "unknown"
                if got == want { right += 1 } else { wrong.append("\(name): \(got) instead of \(want)") }
            }
            print("MEASURE forms page \(page) names only: \(right) of \(bare.count) right in \(String(format: "%.1f", Date().timeIntervalSince(started))) s; wrong: \(wrong)")
        }

    }
}
