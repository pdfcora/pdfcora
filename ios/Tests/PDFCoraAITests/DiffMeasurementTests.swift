import XCTest
@testable import PDFCora
@testable import PDFCoraAI

/// How Apple's on-device model labels the shared diff fixture's two reworded pairs.
/// Opt-in: `TEST_RUNNER_PDFCORA_MEASURE_APPLE=1` in the environment of `xcodebuild test`.
final class DiffMeasurementTests: XCTestCase {
    func testAppleModelOnTheDiffFixture() async throws {
        guard ProcessInfo.processInfo.environment["PDFCORA_MEASURE_APPLE"] == "1" else {
            throw XCTSkip("set TEST_RUNNER_PDFCORA_MEASURE_APPLE=1")
        }
        let dir = RedactionPatternTests.root.appendingPathComponent("conformance/diff")
        let original = try await PdfDocument(data: try Data(contentsOf: dir.appendingPathComponent("original.pdf")))
        let revised = try await PdfDocument(data: try Data(contentsOf: dir.appendingPathComponent("revised.pdf")))
        // The first readings after launch report no prompt budget; one call wakes the model.
        _ = try? await AppleModel.respond(to: "Reply with OK.")
        for run in 1...3 {
            let diff = try await PdfAI(document: original).diff.compare(revised: revised)
            let modified = diff.changes.filter { $0.kind == .modified }
            print("MEASURE run \(run): modelUsed=\(diff.modelUsed) \(modified.map { "\($0.label.rawValue)[\($0.source)] \($0.summary ?? "-")" })")
        }
    }
}
