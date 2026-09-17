import XCTest
@testable import PDFCora

/// How far a genuinely hung render spreads.
///
/// `conformance/hang-probe.pdf` never returns from `FPDF_RenderPageBitmap_Start`. Every
/// PDFium call shares one engine thread, so without the watchdog this blocks every
/// document forever; with it, calls behind the hang fail fast.
///
/// Runs in its own pass (see `scripts/test-ios.sh`): the render spins a core until the
/// process exits and the engine stays unresponsive, so no test may run after it.
final class BlastRadiusTests: LicensedTestCase {

    func testAHungRenderFailsOtherDocumentsFastInsteadOfBlockingThem() async throws {
        PdfDocument.engineTimeout = 1
        let helloWorld = try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf"))
        let other = try await PdfDocument(data: helloWorld)
        let hung = try await PdfDocument(
            data: try Data(contentsOf: Repo.root.appendingPathComponent("conformance/hang-probe.pdf")))

        let page = try await hung.page(0)
        Task.detached { _ = try? await page.render(width: 80) }
        try await Task.sleep(nanoseconds: 2_000_000_000)

        var ticks = 0
        for _ in 0..<10 {
            try await Task.sleep(nanoseconds: 100_000_000)
            ticks += 1
        }
        XCTAssertEqual(ticks, 10, "unrelated async work was starved")

        let started = Date()
        do {
            _ = try await other.page(0).render(width: 120)
            XCTFail("a render behind the hung one completed")
        } catch PdfError.engineUnresponsive {}
        do {
            _ = try await PdfDocument(data: helloWorld)
            XCTFail("opening behind the hung render completed")
        } catch PdfError.engineUnresponsive {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 1, "failing fast took too long")
    }
}
