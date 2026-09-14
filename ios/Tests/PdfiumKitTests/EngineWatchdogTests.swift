import XCTest
@testable import PdfiumKit

/// Every PDFium call shares one engine thread, so a call that never returns would block
/// every document forever. Calls queued behind one that outlives the deadline fail fast
/// instead, and service resumes if it ever returns.
final class EngineWatchdogTests: XCTestCase {

    override func tearDown() {
        PdfDocument.engineTimeout = 30
    }

    func testCallsBehindAStuckCallFailFastAndServiceResumesWhenItReturns() async throws {
        let data = try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf"))
        let document = try await PdfDocument(data: data)
        PdfDocument.engineTimeout = 0.5

        let release = DispatchSemaphore(value: 0)
        Thread { try? EngineExecutor.shared.run { release.wait() } }.start()
        try await Task.sleep(nanoseconds: 1_000_000_000)

        let started = Date()
        do {
            _ = try await document.page(0).text.string()
            XCTFail("a call behind the stuck one completed")
        } catch PdfError.engineUnresponsive {}
        do {
            _ = try await PdfDocument(data: data)
            XCTFail("opening behind the stuck call completed")
        } catch PdfError.engineUnresponsive {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.5, "failing fast took too long")

        release.signal()
        try await Task.sleep(nanoseconds: 200_000_000)
        let text = try await document.page(0).text.string()
        XCTAssertTrue(text.contains("Hello"))
        await document.close()
    }

    func testWorkQueuedBeforeTheDeadlineIsFailedToo() async throws {
        let data = try Data(contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf"))
        let document = try await PdfDocument(data: data)
        PdfDocument.engineTimeout = 0.5

        let release = DispatchSemaphore(value: 0)
        Thread { try? EngineExecutor.shared.run { release.wait() } }.start()
        try await Task.sleep(nanoseconds: 100_000_000)

        // Queued while the engine is merely busy, before the deadline has passed.
        let queued = Task { try await document.page(0).text.string() }
        do {
            _ = try await queued.value
            XCTFail("the queued call completed")
        } catch PdfError.engineUnresponsive {}

        release.signal()
        try await Task.sleep(nanoseconds: 200_000_000)
        await document.close()
    }
}
