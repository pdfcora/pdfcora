import XCTest
@testable import PdfiumKit

/// Probe, not a regression test: does the render hang seen in the WASM build also
/// occur natively? If it does, this test never finishes — that is the answer.
///
/// Excluded from normal runs with `-skip-testing:PdfiumKitTests/HangProbeTests`, since
/// passing an environment flag through xcodebuild to the test process does not work
/// reliably here. Run it deliberately with `-only-testing` and a time allowance.
final class HangProbeTests: LicensedTestCase {
    /// Disabled: the question is answered — the hang reproduces natively — and this test
    /// never finishes by design. `BlastRadiusTests` covers what the SDK does about it.

    override func setUpWithError() throws {
        throw XCTSkip("probe only; see BlastRadiusTests")
    }

    func testRenderingTheHangDocument() async throws {
        let url = Repo.root.appendingPathComponent("conformance/hang-probe.pdf")
        let document = try await PdfDocument(data: try Data(contentsOf: url))
        print("PROBE: opened, \(await document.pageCount) pages")

        let page = try await document.page(0)
        print("PROBE: size \(try await page.size)")
        print("PROBE: about to render")

        _ = try await page.render(width: 80)
        print("PROBE: RENDER COMPLETED — no hang natively")
        await document.close()
    }
}
