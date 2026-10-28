import XCTest
@testable import PDFCora

/// The iOS twin of `conformance/robustness.mjs`: runs every document in a corpus through the
/// SDK and records what happened, so a malformed file shows up as a typed error rather than
/// a crash.
///
/// Driven by `scripts/sweep-ios.sh`, which passes the corpus, where to write results, and
/// where to start. A crash kills this process, so the script notes the last file started,
/// records it as a crash and runs the test again from the next one. Skipped without a corpus,
/// so it costs nothing in the normal gate.
final class CorpusSweepTests: XCTestCase {
    private let environment = ProcessInfo.processInfo.environment

    func testSweep() async throws {
        guard let corpus = environment["SWEEP_CORPUS"], let results = environment["SWEEP_RESULTS"] else {
            throw XCTSkip("set SWEEP_CORPUS and SWEEP_RESULTS; see scripts/sweep-ios.sh")
        }
        let start = Int(environment["SWEEP_START"] ?? "0") ?? 0
        let root = URL(fileURLWithPath: corpus)
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "pdf" } ?? [])
            .map { $0.path.replacingOccurrences(of: root.path + "/", with: "") }
            .sorted()
        // A hung render holds the engine; calls behind it then fail fast instead of waiting.
        PdfDocument.engineTimeout = 10

        for index in start..<files.count {
            try "\(index)".write(toFile: results + ".started", atomically: true, encoding: .utf8)
            let outcome = await exercise(root.appendingPathComponent(files[index]))
            append(["index": index, "file": files[index]].merging(outcome) { a, _ in a }, to: results)
            // The engine is wedged for the rest of this process; the script starts a fresh one.
            if outcome["outcome"] as? String == "timeout" { return }
        }
    }

    /// Everything `robustness.mjs` does, under a deadline, since a call that hangs inside
    /// PDFium never returns to be failed. Detached tasks rather than a task group: a group
    /// waits for its children, and the hung one never finishes.
    private func exercise(_ url: URL) async -> [String: Any] {
        await withCheckedContinuation { continuation in
            let first = FirstResult(continuation)
            Task.detached { first.resume(await Self.exerciseAll(url)) }
            Task.detached {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                first.resume(["outcome": "timeout", "code": "20s"])
            }
        }
    }

    private static func exerciseAll(_ url: URL) async -> [String: Any] {
        let document: PdfDocument
        do {
            document = try await PdfDocument(data: try Data(contentsOf: url))
        } catch let error as PdfError {
            return ["outcome": "rejected", "code": code(error)]
        } catch {
            return ["outcome": "untyped-throw", "code": "\(error)"]
        }

        do {
            let pageCount = await document.pageCount
            for index in 0..<min(pageCount, 3) {
                let page = try await document.page(index)
                _ = try await page.size
                _ = try await page.render(width: 80)
                _ = try await page.text.string()
                _ = try await page.text.characterCount
                _ = try await page.text.search("a")
                _ = try await page.annotations()
                _ = try await page.formFields()
            }
            _ = try await document.metadata
            _ = await document.permissions
            _ = try await document.attachments
            _ = try await document.outline
            _ = try await document.data(mode: .full)
            await document.close()
            return ["outcome": "ok", "pageCount": pageCount]
        } catch let error as PdfError {
            await document.close()
            return ["outcome": error == .engineUnresponsive ? "timeout" : "typed-error", "code": code(error)]
        } catch {
            await document.close()
            return ["outcome": "untyped-throw", "code": "\(error)"]
        }
    }

    /// The web SDK's error code for the same failure, so the reports can be compared.
    private static func code(_ error: PdfError) -> String {
        switch error {
        case .passwordRequired: return "passwordRequired"
        case .wrongPassword: return "wrongPassword"
        case .corrupt: return "corrupt"
        case .unsupportedSecurity: return "unsupportedSecurity"
        case .pageOutOfRange: return "pageOutOfRange"
        case .closed: return "closed"
        case .cancelled: return "cancelled"
        case .saveFailed: return "saveFailed"
        case .invalidOperation: return "invalidOperation"
        case .engine: return "engine"
        case .engineUnresponsive: return "engineUnresponsive"
        case .readOnlyFollower: return "readOnlyFollower"
        case .documentMismatch: return "documentMismatch"
        }
    }

    private func append(_ record: [String: Any], to path: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else { return }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        guard let handle = FileHandle(forWritingAtPath: path) else { return }
        handle.seekToEndOfFile()
        handle.write(data + Data("\n".utf8))
        handle.closeFile()
    }
}

/// Resumes a continuation with whichever result arrives first, and ignores the other.
private final class FirstResult: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<[String: Any], Never>?

    init(_ continuation: CheckedContinuation<[String: Any], Never>) { self.continuation = continuation }

    func resume(_ result: [String: Any]) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: result)
    }
}
