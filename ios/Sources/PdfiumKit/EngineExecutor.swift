import Foundation

/// The one thread every PDFium call in the process runs on.
///
/// `PdfDocument` is an actor, which serialises calls on a *single* document — but each
/// actor would otherwise get its own executor, so two documents would run on two
/// threads. PDFium's global state is not thread-safe, and that arrangement kills the
/// process: `CrossDocumentStressTests` reproduces it, as its Android twin does.
///
/// Every document shares this executor, so the actor isolation that already protected
/// one document now protects the engine as a whole.
///
/// The cost is that documents no longer work in parallel with each other, and a hung
/// render wedges the engine for everyone. There is no third option while PDFium stays
/// single-threaded: correctness requires serialisation, and serialisation means one
/// stuck call blocks the queue.
final class EngineExecutor: SerialExecutor, @unchecked Sendable {
    static let shared = EngineExecutor()

    private let queue = DispatchQueue(label: "com.pdfiumkit.engine")

    private init() { markQueue() }

    func enqueue(_ job: UnownedJob) {
        let executor = asUnownedSerialExecutor()
        queue.async { job.runSynchronously(on: executor) }
    }

    func asUnownedSerialExecutor() -> UnownedSerialExecutor {
        UnownedSerialExecutor(ordinary: self)
    }

    /// Runs `body` on the engine thread and waits.
    ///
    /// For the one place actor isolation cannot reach: an actor's `init` runs on the
    /// caller's context, not on the actor's executor, so the PDFium calls that open a
    /// document would otherwise race every other document's work.
    ///
    /// Re-entrancy is handled rather than deadlocking: opening a document from inside
    /// another document's isolated method is already on this thread, and `sync` there
    /// would deadlock.
    func run<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: Self.marker) != nil { return try body() }
        return try queue.sync { try body() }
    }

    /// Queues `body` on the engine thread without waiting.
    ///
    /// For `deinit`, which runs on whatever thread drops the last reference and must not
    /// block it — and must not `sync` onto a queue it may already be on.
    func runAsync(_ body: @escaping @Sendable () -> Void) {
        queue.async(execute: body)
    }

    private static let marker = DispatchSpecificKey<Bool>()
    private func markQueue() { queue.setSpecific(key: Self.marker, value: true) }
}
