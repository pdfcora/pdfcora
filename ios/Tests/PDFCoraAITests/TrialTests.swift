import XCTest
@testable import PDFCoraAI

final class TrialTests: LicensedTestCase {
    func testAnswersAndSummariesArePrefixedWithoutAnAiLicense() {
        let answer = PdfAiOutcome<PdfAnswer>.answered(PdfAiResult(
            value: .answered(text: "Yes.", citations: [], grounded: true, pagesWithoutText: []), source: .rules))
        guard case .answered(let marked) = Trial.mark(answer, licensed: false),
              case .answered(let text, _, _, _) = marked.value else { return XCTFail() }
        XCTAssertEqual(text, "PDFCora trial — Yes.")

        let summary = PdfAiOutcome<PdfSummary>.answered(PdfAiResult(
            value: PdfSummary(text: "Short.", pagesWithoutText: []), source: .rules))
        guard case .answered(let kept) = Trial.mark(summary, licensed: true) else { return XCTFail() }
        XCTAssertEqual(kept.value.text, "Short.")
    }
}
