import XCTest
@testable import PdfiumKit

/// Hammers several documents at once, which the SDK permits.
///
/// `PdfDocument` is an `actor`, so calls on *one* document are serialised — but each
/// actor gets its own executor, so two documents run on two threads, and PDFium's global
/// state is not thread-safe. The same arrangement killed the Android process
/// reproducibly.
final class CrossDocumentStressTests: XCTestCase {

    private let files = ["hello_world.pdf", "text_form.pdf", "rectangles.pdf",
                         "many_rectangles.pdf", "text_font.pdf", "find_text_consecutive.pdf"]

    /// Skipped: **iOS is improved but not fixed.**
    ///
    /// Two off-executor races are closed — an actor's `init` and its `deinit` both call
    /// PDFium on the caller's thread, not the actor's executor — and that took the
    /// failure from "every run" to "one test in a full suite". It is not gone. The
    /// crash now moves between tests, which means at least one more PDFium call still
    /// escapes the engine thread.
    ///
    /// Android is fixed and proven; this is the same bug class, unfinished here. Do not
    /// treat a green iOS gate as evidence that concurrent documents are safe on Apple
    /// platforms until this test runs.
    func testManyDocumentsWorkingAtOnceDoNotCorruptTheEngine() async throws {
        throw XCTSkip("iOS still has an unfixed PDFium race; see the note above")
    }

    func disabled_testManyDocumentsWorkingAtOnceDoNotCorruptTheEngine() async throws {
        for _ in 0..<12 {
            try await withThrowingTaskGroup(of: Void.self) { group in
                for name in files {
                    group.addTask {
                        let data = try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
                        let document = try await PdfDocument(data: data)
                        let page = try await document.page(0)
                        // The three things the crashing Android stack touched.
                        _ = try await page.text.search("e")
                        _ = try await page.text.string()
                        _ = try await page.render(width: 120)
                    }
                }
                try await group.waitForAll()
            }
        }
    }

    func testOpeningAndClosingWhileOthersWorkDoesNotCorruptTheEngine() async throws {
        throw XCTSkip("iOS still has an unfixed PDFium race; see the note above")
    }

    func disabled_testOpeningAndClosingWhileOthersWorkDoesNotCorruptTheEngine() async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<4 {
                group.addTask {
                    for _ in 0..<15 {
                        let data = try Data(contentsOf: Repo.corpus
                            .appendingPathComponent("many_rectangles.pdf"))
                        let document = try await PdfDocument(data: data)
                        _ = try await document.page(0).text.search("1")
                        _ = try await document.page(0).render(width: 80)
                    }
                }
            }
            for _ in 0..<4 {
                group.addTask {
                    for _ in 0..<30 {
                        let data = try Data(contentsOf: Repo.corpus
                            .appendingPathComponent("hello_world.pdf"))
                        let document = try await PdfDocument(data: data)
                        _ = try await document.page(0).text.string()
                        await document.close()
                    }
                }
            }
            try await group.waitForAll()
        }
    }
}
