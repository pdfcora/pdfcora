import XCTest
@testable import PdfiumKit

/// Probe, not a regression test: does the render hang seen in the WASM build also
/// occur natively? If it does, this test never finishes — that is the answer.
///
/// Excluded from normal runs with `-skip-testing:PdfiumKitTests/HangProbeTests`, since
/// passing an environment flag through xcodebuild to the test process does not work
/// reliably here. Run it deliberately with `-only-testing` and a time allowance.
final class HangProbeTests: XCTestCase {
    /// Disabled: cannot run against a serialised engine.
    ///
    /// This works by wedging a render forever. Every PDFium call now shares one engine
    /// thread — because per-document threads let documents race PDFium's global state
    /// and killed the process, which `CrossDocumentStressTests` reproduces — so the
    /// wedge outlives the test and takes every later call with it.
    ///
    /// Re-enable if a watchdog is added that can abandon a stuck engine thread.

    override func setUpWithError() throws {
        throw XCTSkip("a deliberate hang cannot coexist with a single shared engine thread")
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
