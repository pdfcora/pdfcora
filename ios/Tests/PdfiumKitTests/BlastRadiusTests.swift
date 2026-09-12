import XCTest
@testable import PdfiumKit

/// Establishes how far a hung render spreads, which is what decides whether an app
/// needs process isolation or can simply abandon the affected document.
///
/// **Excluded from normal runs** with `-skip-testing:PdfiumKitTests/BlastRadiusTests`.
/// The hung render spins a core forever and prevents the test process from exiting, so
/// this is one test making every assertion from a single hang. Run it deliberately:
///
///     xcodebuild test -scheme PdfiumKit -destination '...' \
///       -only-testing:PdfiumKitTests/BlastRadiusTests \
///       -test-timeouts-enabled YES -default-test-execution-time-allowance 90
///
/// Expect the run to report the test result and then hang at teardown; that is the
/// finding, not a failure.
final class BlastRadiusTests: XCTestCase {
    func testAHungRenderIsContainedToItsOwnDocument() async throws {
        let hangURL = Repo.root.appendingPathComponent("conformance/hang-probe.pdf")
        let wedged = try await PdfDocument(data: try Data(contentsOf: hangURL))
        let wedgedPage = try await wedged.page(0)

        Task.detached { _ = try? await wedgedPage.render(width: 80) }   // never returns
        try await Task.sleep(nanoseconds: 500_000_000)

        // 1. The caller keeps running: the hang belongs to that document's executor.
        var ticks = 0
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 50_000_000)
            ticks += 1
        }
        XCTAssertEqual(ticks, 20, "the calling context was blocked by the hang")

        // 2. A different document is completely unaffected — separate executors.
        let other = try await PdfDocument(
            data: try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf")))
        let page = try await other.page(0)
        let image = try await page.render(width: 120)
        XCTAssertEqual(image.size.width, 120, accuracy: 1)
        let text = try await page.text.string()
        XCTAssertTrue(text.contains("Hello"))
        await other.close()

        // 3. The wedged document itself is lost: further calls never return. An app has
        //    to race its own deadline and give up on that document.
        let probe = Task { try await wedged.pageCount }
        let outcome = await withTaskGroup(of: String.self) { group -> String in
            group.addTask { _ = try? await probe.value; return "returned" }
            group.addTask { try? await Task.sleep(nanoseconds: 1_500_000_000); return "timed-out" }
            let first = await group.next()!
            group.cancelAll()
            return first
        }
        XCTAssertEqual(outcome, "timed-out",
                       "the wedged document answered; if this changes, the docs are wrong")
        probe.cancel()

        print("BLAST: caller responsive, other document fine, wedged document unreachable")
    }
}
