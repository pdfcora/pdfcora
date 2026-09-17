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
/// The cost is that one stuck call would block every document. PDFium can hang inside a
/// single call — `conformance/hang-probe.pdf` never returns from
/// `FPDF_RenderPageBitmap_Start` — and a thread stuck in native code cannot be killed. So
/// there is a watchdog: work is fed to the engine thread one item at a time, and when an
/// item outlives ``timeout`` everything behind it runs on a rescue queue instead, where
/// ``ensureResponsive()`` throws ``PdfError/engineUnresponsive``. If the stuck call ever
/// returns, the engine takes work again.
///
/// Code reached from a job must call ``ensureResponsive()`` — through
/// `PdfDocument.requireHandle()` in practice — before touching PDFium, because on the
/// rescue queue it runs alongside the stuck call.
final class EngineExecutor: SerialExecutor, @unchecked Sendable {
    static let shared = EngineExecutor()

    private enum Work {
        case job(UnownedJob)
        case block(() -> Void)
    }

    private let queue = DispatchQueue(label: "com.pdfcora.engine")
    private let rescue = DispatchQueue(label: "com.pdfcora.engine.rescue")
    private let watchdog = DispatchQueue(label: "com.pdfcora.engine.watchdog")

    private let lock = NSLock()
    private var pending: [Work] = []
    private var feeding = false
    private var running: Int?
    private var generation = 0
    private var stuck = false
    private var timeoutStorage: TimeInterval = 30

    private init() {
        queue.setSpecific(key: Self.engineMarker, value: true)
        rescue.setSpecific(key: Self.rescueMarker, value: true)
    }

    /// How long one call may run before the calls behind it are failed.
    var timeout: TimeInterval {
        get { locked { timeoutStorage } }
        set { locked { timeoutStorage = newValue } }
    }

    func enqueue(_ job: UnownedJob) {
        submit(.job(job))
    }

    func asUnownedSerialExecutor() -> UnownedSerialExecutor {
        UnownedSerialExecutor(ordinary: self)
    }

    /// False on the rescue queue, where PDFium must not be touched: a stuck call still
    /// holds the engine.
    var isResponsive: Bool { DispatchQueue.getSpecific(key: Self.rescueMarker) == nil }

    func ensureResponsive() throws {
        if !isResponsive { throw PdfError.engineUnresponsive }
    }

    /// Runs `body` on the engine thread and waits.
    ///
    /// For the one place actor isolation cannot reach: an actor's `init` runs on the
    /// caller's context, not on the actor's executor, so the PDFium calls that open a
    /// document would otherwise race every other document's work.
    ///
    /// Re-entrancy is handled rather than deadlocking: opening a document from inside
    /// another document's isolated method is already on this thread.
    ///
    /// `body` is escaping although this waits: the queue that ran it can still hold the
    /// closure for a moment after the caller wakes, which `withoutActuallyEscaping` traps.
    func run<T>(_ body: @escaping () throws -> T) throws -> T {
        if DispatchQueue.getSpecific(key: Self.engineMarker) != nil { return try body() }
        try ensureResponsive()

        var result: Result<T, Error>!
        let done = DispatchSemaphore(value: 0)
        submit(.block {
            result = self.isResponsive ? Result { try body() } : .failure(PdfError.engineUnresponsive)
            done.signal()
        })
        done.wait()
        return try result.get()
    }

    /// Queues `body` on the engine thread without waiting, and without a deadline.
    ///
    /// For freeing handles from `deinit`, which runs on whatever thread drops the last
    /// reference and must not block it. It bypasses the watchdog on purpose: frees must
    /// happen on the engine thread even when it is stuck, whenever it comes back.
    func runAsync(_ body: @escaping @Sendable () -> Void) {
        queue.async(execute: body)
    }

    private func submit(_ work: Work) {
        lock.lock()
        if stuck {
            lock.unlock()
            rescue.async { self.execute(work) }
            return
        }
        pending.append(work)
        let start = !feeding
        feeding = true
        lock.unlock()
        if start { queue.async { self.feed() } }
    }

    /// Runs one queued item on the engine thread under a deadline, then yields the queue
    /// so frees from ``runAsync(_:)`` are not starved by a steady stream of work.
    private func feed() {
        lock.lock()
        guard !pending.isEmpty else {
            feeding = false
            lock.unlock()
            return
        }
        let work = pending.removeFirst()
        generation += 1
        let current = generation
        running = current
        let deadline = timeoutStorage
        lock.unlock()

        watchdog.asyncAfter(deadline: .now() + deadline) { self.expire(current) }
        execute(work)

        locked {
            running = nil
            stuck = false
        }
        queue.async { self.feed() }
    }

    private func expire(_ generation: Int) {
        lock.lock()
        guard running == generation, !stuck else {
            lock.unlock()
            return
        }
        stuck = true
        let abandoned = pending
        pending.removeAll()
        lock.unlock()
        for work in abandoned { rescue.async { self.execute(work) } }
    }

    private func execute(_ work: Work) {
        switch work {
        case .job(let job): job.runSynchronously(on: asUnownedSerialExecutor())
        case .block(let body): body()
        }
    }

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private static let engineMarker = DispatchSpecificKey<Bool>()
    private static let rescueMarker = DispatchSpecificKey<Bool>()
}
