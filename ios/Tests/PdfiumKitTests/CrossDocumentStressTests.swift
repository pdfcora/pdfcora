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

    func testManyDocumentsWorkingAtOnceDoNotCorruptTheEngine() async throws {
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

    /// A dropped document's handles are freed on the engine thread *after* the actor's
    /// own memory is gone, so nothing PDFium still points into may live in the actor.
    /// Holding the engine while freed memory is overwritten makes that deterministic.
    func testFreeingADroppedDocumentDoesNotReadItsReleasedMemory() async throws {
        let data = try Data(contentsOf: Repo.corpus.appendingPathComponent("text_form.pdf"))
        var documents: [PdfDocument] = []
        for _ in 0..<20 {
            let document = try await PdfDocument(data: data)
            _ = try await document.page(0).formFields()
            documents.append(document)
        }

        let documentWords = malloc_size(Unmanaged.passUnretained(documents[0]).toOpaque()) / 8
        let gate = DispatchSemaphore(value: 0)
        EngineExecutor.shared.runAsync { gate.wait() }
        documents.removeAll()

        // Swift objects in the actor's size class, full of pointers into non-executable
        // memory: raw byte allocations land in a different malloc bucket and never reuse
        // the freed slot. The `- 4` absorbs ManagedBuffer's header.
        let target = UnsafeMutableRawPointer.allocate(byteCount: 64, alignment: 8)
        defer { target.deallocate() }
        var scribble: [ManagedBuffer<Void, UnsafeRawPointer>] = []
        for _ in 0..<2000 {
            let buffer = ManagedBuffer<Void, UnsafeRawPointer>.create(minimumCapacity: documentWords - 4) { _ in }
            let capacity = buffer.capacity
            buffer.withUnsafeMutablePointerToElements {
                $0.initialize(repeating: UnsafeRawPointer(target), count: capacity)
            }
            scribble.append(buffer)
        }

        gate.signal()
        EngineExecutor.shared.run {}
    }

    func testOpeningAndClosingWhileOthersWorkDoesNotCorruptTheEngine() async throws {
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
