import XCTest
import PdfiumKit
@testable import PdfiumKitAI

/// The same assertions as `web-ai/test/{provider,proposal}.test.ts`.
///
/// If a Swift test here needs different assertions than its TypeScript twin, the two
/// implementations have diverged and one of them is wrong.
final class ContractTests: XCTestCase {

    private struct BrokenProvider: PdfAiProvider {
        struct Boom: Error {}
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse { throw Boom() }
    }

    private func document() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(
            contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf")))
    }

    // MARK: - Resolution order

    func testRoutesAreTriedInOrderAndTheWinnerIsNamed() async {
        let calls = Recorder()
        let outcome: PdfAiOutcome<String> = await resolveRoutes(
            onDevice: { await calls.add("onDevice"); return nil },
            customProvider: { await calls.add("provider"); return "from-provider" },
            rules: { await calls.add("rules"); return "from-rules" })

        let seen = await calls.calls
        XCTAssertEqual(seen, ["onDevice", "provider"],
                       "the rules fallback must not run once a provider answered")
        guard case .answered(let result) = outcome else { return XCTFail("expected an answer") }
        XCTAssertEqual(result.value, "from-provider")
        XCTAssertEqual(result.source, .customProvider)
    }

    func testEveryRouteEmptyIsUnavailableNotAThrow() async {
        let outcome: PdfAiOutcome<String> = await resolveRoutes(
            onDevice: { nil }, customProvider: { nil }, rules: { nil })
        guard case .unavailable(let state) = outcome else { return XCTFail("expected unavailable") }
        XCTAssertEqual(state, .unavailable(.noProvider))
    }

    /// On a real phone ML Kit threw on every call while reporting itself available, and the
    /// caller was told to configure a provider. A failure is not a missing configuration.
    func testWhenARouteThrowsAndNothingAnswersTheReasonIsRequestFailed() async {
        struct Boom: Error {}
        let outcome: PdfAiOutcome<String> = await resolveRoutes(
            onDevice: { throw Boom() }, customProvider: { nil })
        guard case .unavailable(let state) = outcome else { return XCTFail("expected unavailable") }
        XCTAssertEqual(state, .unavailable(.requestFailed))
    }

    func testARouteThatThrowsDoesNotStopTheNextOne() async {
        struct Boom: Error {}
        let outcome: PdfAiOutcome<String> = await resolveRoutes(
            onDevice: { nil },
            customProvider: { throw Boom() },
            rules: { "from-rules" })

        guard case .answered(let result) = outcome else { return XCTFail("expected an answer") }
        XCTAssertEqual(result.source, .rules)
    }

    func testOnDeviceWinsOutrightWhenItAnswers() async {
        let calls = Recorder()
        let outcome: PdfAiOutcome<String> = await resolveRoutes(
            onDevice: { await calls.add("onDevice"); return "local" },
            customProvider: { await calls.add("provider"); return "remote" })

        // PRV-2's order exists so document content stays on the device when it can.
        let seen = await calls.calls
        XCTAssertEqual(seen, ["onDevice"])
        guard case .answered(let result) = outcome else { return XCTFail("expected an answer") }
        XCTAssertEqual(result.source, .onDevice)
    }

    // MARK: - Proposals

    func testNothingIsWrittenUntilApplyIsCalled() async throws {
        let written = Recorder()
        let set = PdfProposalSet<String>([
            PdfProposal(id: "p1", kind: .formValue, detail: "Ada", source: .rules),
            PdfProposal(id: "p2", kind: .formValue, detail: "Lovelace", source: .rules),
        ], write: { await written.add($0.id) })

        var seen = await written.calls
        XCTAssertEqual(seen, [], "building the set must not touch the document")

        try await set.apply(accepting: ["p1"])
        seen = await written.calls
        XCTAssertEqual(seen, ["p1"], "only the accepted proposal is written")
    }

    func testAnUnknownIdIsRefusedAndWritesNothing() async {
        let written = Recorder()
        let set = PdfProposalSet<String>([
            PdfProposal(id: "p1", kind: .altText, detail: "a cat", source: .onDevice),
        ], write: { await written.add($0.id) })

        do {
            try await set.apply(accepting: ["p1", "ghost"])
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? PdfProposalError, .unknownProposal("ghost"))
        }
        let seen = await written.calls
        XCTAssertEqual(seen, [], "a set with one bad id must leave the document untouched")
    }

    func testProposalsAreWrittenInProposalOrderNotAcceptanceOrder() async throws {
        let written = Recorder()
        let set = PdfProposalSet<String>([
            PdfProposal(id: "a", kind: .redaction, detail: "x", source: .rules),
            PdfProposal(id: "b", kind: .redaction, detail: "y", source: .rules),
        ], write: { await written.add($0.id) })

        try await set.apply(accepting: ["b", "a"])
        let seen = await written.calls
        XCTAssertEqual(seen, ["a", "b"])
    }

    // MARK: - Features

    func testABrokenProviderDegradesRatherThanThrowing() async throws {
        var options = PdfiumAIOptions(provider: BrokenProvider())
        options.allowsOnDevice = false
        let ai = PdfiumAI(document: try await document(), options: options)
        guard case .unavailable(let state) = await ai.summaries.summarize() else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(state, .unavailable(.requestFailed))
    }

    func testNothingDownloadsUnlessTheHostAsks() async throws {
        let ai = PdfiumAI(document: try await document())
        let progress = Recorder()

        _ = ai.summaries.availability()
        var seen = await progress.calls
        XCTAssertEqual(seen, [], "checking availability must never start a download (AVL-4)")

        _ = await ai.summaries.prepare { _ in Task { await progress.add("tick") } }
        try await Task.sleep(nanoseconds: 10_000_000)
        seen = await progress.calls
        XCTAssertFalse(seen.isEmpty, "prepare must report progress, even trivially")
    }
}

/// The corpus path. `PdfiumKitTests` has its own copy; test targets cannot see each
/// other's types, so this is duplicated rather than shared.
enum Repo {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // PdfiumKitAITests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // ios
        .deletingLastPathComponent()   // repo root

    static var corpus: URL { root.appendingPathComponent("conformance/corpus") }
    static var fixtures: URL { root.appendingPathComponent("conformance/fixtures") }
}

/// Ordered call recording across concurrency domains.
actor Recorder {
    private(set) var calls: [String] = []
    func add(_ call: String) { calls.append(call) }
}
