import XCTest
@testable import PdfiumKit

/// Measures how far a hung render spreads. Excluded from normal runs — it spins cores
/// forever and stops the test process from exiting.
///
///     xcodebuild test -scheme PdfiumKit -destination '...' \
///       -only-testing:PdfiumKitTests/BlastRadiusTests
final class BlastRadiusTests: XCTestCase {
    private func hangingRender() async throws {
        let data = try Data(contentsOf: Repo.root.appendingPathComponent("conformance/hang-probe.pdf"))
        let document = try await PdfDocument(data: data)
        let page = try await document.page(0)
        Task.detached { _ = try? await page.render(width: 80) }
    }

    /// Prints progress at every step so a starved run shows exactly where it stopped.
    func testOneHungRender() async throws {
        print("BLAST: start")
        try await hangingRender()
        try await Task.sleep(nanoseconds: 500_000_000)
        print("BLAST: hang running")

        // Does unrelated async work still make progress?
        var ticks = 0
        for _ in 0..<10 {
            try await Task.sleep(nanoseconds: 100_000_000)
            ticks += 1
        }
        print("BLAST: ticks=\(ticks)")

        // Does a *different* document still work?
        let other = try await PdfDocument(
            data: try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf")))
        let image = try await (try await other.page(0)).render(width: 120)
        print("BLAST: other document rendered \(Int(image.size.width))px")
        await other.close()

        XCTAssertEqual(ticks, 10)
        print("BLAST: done")
    }

    /// Repeats the hang to find out whether damage accumulates with the thread pool.
    func testManyHungRenders() async throws {
        let cores = ProcessInfo.processInfo.activeProcessorCount
        print("BLAST-MANY: cores=\(cores), starting \(cores + 2) hangs")

        for i in 0..<(cores + 2) {
            try await hangingRender()
            print("BLAST-MANY: started hang \(i + 1)")
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        print("BLAST-MANY: all hangs started — if this line is the last, the pool starved")

        let other = try await PdfDocument(
            data: try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf")))
        _ = try await (try await other.page(0)).render(width: 120)
        print("BLAST-MANY: another document STILL renders")
        await other.close()
    }
}
