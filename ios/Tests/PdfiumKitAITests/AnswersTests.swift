import XCTest
import PdfiumKit
@testable import PdfiumKitAI

/// The same assertions as `web-ai/test/answers.test.ts` and `summaries.test.ts`.
final class AnswersTests: LicensedTestCase {
    private let notice = "The notice period is three months, ending on the last day of a calendar month."

    private func contract() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Repo.fixtures.appendingPathComponent("contract.pdf")))
    }

    /// A provider that replies with whatever `reply` builds from the prompt it was shown.
    private final class Model: PdfAiProvider, @unchecked Sendable {
        let reply: @Sendable (String) -> String
        private(set) var prompts: [PdfAiRequest] = []
        init(_ reply: @escaping @Sendable (String) -> String) { self.reply = reply }
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            prompts.append(request)
            return PdfAiResponse(text: "", structured: reply(request.prompt))
        }
    }

    private func ai(_ document: PdfDocument, _ model: PdfAiProvider?) -> PdfiumAI {
        var options = PdfiumAIOptions(provider: model)
        options.allowsOnDevice = false
        return PdfiumAI(document: document, options: options)
    }

    /// The id the prompt gave the passage containing `text`.
    private static func passageId(_ prompt: String, _ text: String) -> String {
        let line = prompt.split(separator: "\n").first { $0.contains(text) } ?? ""
        return String(line.dropFirst().prefix { $0 != "]" })
    }

    private static func reply(answer: String, passage: String, quote: String) -> String {
        let object: [String: Any] = ["answer": answer, "citations": [["passage": passage, "quote": quote]]]
        return String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
    }

    private func answered(_ outcome: PdfAiOutcome<PdfAnswer>, file: StaticString = #filePath, line: UInt = #line)
        -> (text: String, citations: [PdfCitation], grounded: Bool, pagesWithoutText: [Int], source: PdfAiSource)? {
        guard case .answered(let result) = outcome,
              case .answered(let text, let citations, let grounded, let pagesWithoutText) = result.value else {
            XCTFail("expected an answer, got \(outcome)", file: file, line: line)
            return nil
        }
        return (text, citations, grounded, pagesWithoutText, result.source)
    }

    func testTheNoticePeriodQuestionHighlightsExactlyThatSentence() async throws {
        let document = try await contract()
        let notice = self.notice
        let model = Model { prompt in
            Self.reply(answer: "Three months.", passage: Self.passageId(prompt, notice), quote: notice)
        }
        guard let answer = answered(await ai(document, model).answers.ask("What's the notice period?")) else { return }

        XCTAssertEqual(answer.source, .customProvider)
        XCTAssertTrue(answer.grounded)
        XCTAssertEqual(answer.citations.count, 1)
        let citation = try XCTUnwrap(answer.citations.first)
        XCTAssertEqual(citation.pageIndex, 1)
        XCTAssertEqual(citation.quote, notice)
        let pageText = try await document.page(1).text.string()
        XCTAssertEqual(NSString(string: pageText).substring(with: NSRange(location: citation.range.lowerBound,
                                                                         length: citation.range.count)), notice)
        XCTAssertEqual(citation.rects.count, 1, "one line of text is one rectangle")
        let rect = try XCTUnwrap(citation.rects.first)
        XCTAssertTrue(rect.left > 72 && rect.left < 110, "left edge \(rect.left) is not after \"12.1 \"")
        XCTAssertTrue(rect.bottom >= 700 && rect.top <= 720, "\(rect) is not on line two")
        await document.close()
    }

    func testThePromptCarriesRetrievedPassagesASchemaAndTheQuestion() async throws {
        let document = try await contract()
        let model = Model { _ in #"{"answer":"","citations":[]}"# }
        _ = await ai(document, model).answers.ask("When are invoices payable?")

        let request = try XCTUnwrap(model.prompts.first)
        XCTAssertNotNil(request.schema, "structured output must be requested (ANS-2)")
        XCTAssertTrue(request.prompt.contains("Invoices are payable within thirty days of receipt."))
        XCTAssertTrue(request.prompt.hasSuffix("Question: When are invoices payable?"))
        await document.close()
    }

    func testAQuestionWithNoAnswerIsNotFoundWithoutCallingTheModel() async throws {
        let document = try await contract()
        let model = Model { _ in XCTFail("the model must not be called (ANS-4)"); return "" }
        let outcome = await ai(document, model).answers.ask("zeppelin xylophone?")

        guard case .answered(let result) = outcome else { return XCTFail("expected a result") }
        XCTAssertEqual(result.value, .notFound(pagesWithoutText: [2]))
        XCTAssertEqual(result.source, .rules)
        XCTAssertTrue(model.prompts.isEmpty)
        await document.close()
    }

    func testAMadeUpQuoteNeverProducesAHighlight() async throws {
        let document = try await contract()
        let notice = self.notice
        let model = Model { prompt in
            Self.reply(answer: "Six months.", passage: Self.passageId(prompt, notice),
                       quote: "The notice period is six months.")
        }
        guard let answer = answered(await ai(document, model).answers.ask("What's the notice period?")) else { return }
        XCTAssertTrue(answer.citations.isEmpty)
        XCTAssertFalse(answer.grounded)
        await document.close()
    }

    /// Apple's model quoted correctly but named passages "p1-3" and "13. Payment": ids are
    /// what it gets wrong, so the quote, not the id, decides.
    func testAQuoteCreditedToTheWrongOrAnUnknownPassageIsFoundInThePassagesShown() async throws {
        let document = try await contract()
        let notice = self.notice
        let ids: [@Sendable (String) -> String] = [{ Self.passageId($0, "maintenance services") }, { _ in "13. Payment" }]
        for id in ids {
            let model = Model { prompt in Self.reply(answer: "Three months.", passage: id(prompt), quote: notice) }
            guard let answer = answered(await ai(document, model).answers.ask(
                "What is the notice period for the maintenance services?")) else { return }
            XCTAssertTrue(answer.grounded)
            XCTAssertEqual(answer.citations.first?.pageIndex, 1)
            XCTAssertEqual(answer.citations.first?.quote, notice)
        }
        await document.close()
    }

    func testARealSentenceTheModelWasNotShownIsNeverACitation() async throws {
        let document = try await contract()
        let notice = self.notice
        let start = "The agreement starts on 1 March 2026 and runs for an initial term of two years."
        let model = Model { prompt in
            XCTAssertFalse(prompt.contains("1 March 2026"), "the budget should admit only the page-2 passage")
            return Self.reply(answer: "Three months.", passage: Self.passageId(prompt, notice), quote: start)
        }
        // Room for one passage, so page 1 is never in the prompt.
        var options = PdfiumAIOptions(provider: model, providerContextTokens: 200)
        options.allowsOnDevice = false
        guard let answer = answered(await PdfiumAI(document: document, options: options)
            .answers.ask("What is the notice period?")) else { return }
        XCTAssertTrue(answer.citations.isEmpty)
        XCTAssertFalse(answer.grounded)
        await document.close()
    }

    /// Apple's model answers "not mentioned in the passages" instead of the empty answer the
    /// prompt asks for. Without a citation there is nothing to verify or highlight.
    func testAnAnswerWithNoCitationsIsNotFoundWhateverItsTextSays() async throws {
        let document = try await contract()
        let model = Model { _ in #"{"answer":"The capital of France is not mentioned in the passages.","citations":[]}"# }
        guard case .answered(let result) = await ai(document, model).answers.ask("What is the notice period?") else {
            return XCTFail("expected a result")
        }
        XCTAssertEqual(result.value, .notFound(pagesWithoutText: [2]))
        XCTAssertEqual(result.source, .customProvider)
        await document.close()
    }

    func testPagesWithoutATextLayerAreReported() async throws {
        let document = try await contract()
        let notice = self.notice
        let model = Model { prompt in
            Self.reply(answer: "Three months.", passage: Self.passageId(prompt, notice), quote: notice)
        }
        guard let answer = answered(await ai(document, model).answers.ask("notice period")) else { return }
        XCTAssertEqual(answer.pagesWithoutText, [2])
        await document.close()
    }

    func testWithoutAProviderAnswersAreUnavailableAsAValue() async throws {
        let document = try await contract()
        let ai = ai(document, nil)
        XCTAssertEqual(ai.answers.availability(), .unavailable(.noProvider))
        guard case .unavailable(let state) = await ai.answers.ask("notice period") else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(state, .unavailable(.noProvider))
        await document.close()
    }

    func testAReplyThatIsFencedJsonInTextIsReadToo() async throws {
        struct Fenced: PdfAiProvider {
            let notice: String
            func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
                PdfAiResponse(text: "```json\n" + AnswersTests.reply(
                    answer: "Three months.", passage: AnswersTests.passageId(request.prompt, notice), quote: notice) + "\n```")
            }
        }
        let document = try await contract()
        guard let answer = answered(await ai(document, Fenced(notice: notice)).answers.ask("notice period")) else { return }
        XCTAssertTrue(answer.grounded)
        await document.close()
    }

    // MARK: - Quote verification

    func testQuotesTolerateWhitespaceAndLineBreaks() {
        let source = "Intro.  The notice\r\nperiod   is three months."
        XCTAssertEqual(locateQuote(in: source, "The notice period is three months."), 8..<source.utf16.count)
    }

    func testQuotesTolerateAWordHyphenatedAcrossALine() {
        let source = "Payment on manage-\nment approval."
        XCTAssertEqual(locateQuote(in: source, "Payment on management approval."), 0..<source.utf16.count)
    }

    func testQuotesKeepACompoundThatBreaksAtALineEnd() {
        let source = "A well-\nknown supplier."
        XCTAssertEqual(locateQuote(in: source, "A well-known supplier."), 0..<source.utf16.count)
    }

    func testQuotesDoNotTolerateDifferentWordsPunctuationOrCase() {
        let source = "The notice period is three months."
        XCTAssertNil(locateQuote(in: source, "The notice period is 3 months."))
        XCTAssertNil(locateQuote(in: source, "The notice period is three months!"))
        XCTAssertNil(locateQuote(in: source, "the notice period is three months."))
        XCTAssertNil(locateQuote(in: source, "   "))
    }

    // MARK: - Retrieval

    func testRetrievalRanksThePassageSharingRareTermsFirst() {
        let passages = ["Invoices are payable within thirty days.", "The notice period is three months.",
                        "Deliveries arrive weekly."].enumerated().map {
            TextLayer.passages(of: PdfPageText(pageIndex: $0.offset, text: $0.element))[0]
        }
        let picked = Retrieval.retrieve(passages, question: "How long is the notice period?", budget: 10_000)
        XCTAssertEqual(picked.first?.text, "The notice period is three months.")
        XCTAssertFalse(picked.contains { $0.text.hasPrefix("Deliveries") })
    }

    func testRetrievalStopsAtTheBudget() {
        let passages = TextLayer.passages(of: PdfPageText(pageIndex: 0, text: "The notice period is three months."))
        XCTAssertEqual(Retrieval.retrieve(passages, question: "notice period", budget: 5), [])
    }

    // MARK: - Summaries

    // Long documents are read in windows: each call carries the summary so far and the next
    // stretch of text, so later parts are summarised knowing what came before (SUM-2).
    private static let pages = (0..<30).map { "Marker\($0) opens this page. " + String(repeating: "Clause text goes here. ", count: 40) }
    private static let next = "Next part:\n"

    private func windows(_ limit: Int, reply: @escaping @Sendable (String, Int) -> String) async throws
        -> (inputs: [String], outputs: [String], result: String) {
        let calls = Recorder()
        let outputs = Recorder()
        let result = try await SummaryText.summariseInWindows(Self.pages, limit: limit) { input in
            await calls.add(input)
            let output = reply(input, await calls.calls.count)
            await outputs.add(output)
            return output
        }
        return (await calls.calls, await outputs.calls, result)
    }

    /// Given a bulleted summary to carry forward, Apple's model bullets its lines again.
    func testRepeatedBulletMarkersFromTheModelCollapseToOne() async throws {
        let result = try await SummaryText.summariseInWindows(["A short page."], limit: 2_000) { _ in
            "- - First point\n* - Second point\n- Third point\nA - dash inside a line"
        }
        XCTAssertEqual(result, "- First point\n- Second point\n- Third point\nA - dash inside a line")
    }

    /// The page markers in the document text of each call, leaving out the summary it carries.
    private static func markers(_ inputs: [String]) -> [Int] {
        inputs.map { input in input.range(of: next).map { String(input[$0.upperBound...]) } ?? input }
            .flatMap { text in
                let regex = try! NSRegularExpression(pattern: "Marker(\\d+)")
                return regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
                    .map { Int((text as NSString).substring(with: $0.range(at: 1)))! }
            }
    }

    func testEveryWindowStaysWithinTheLimitAndTheLastSummaryIsTheResult() async throws {
        let (inputs, outputs, result) = try await windows(2_000) { _, call in "S\(call)" }
        XCTAssertGreaterThan(inputs.count, 1, "thirty long pages cannot fit one window")
        for input in inputs { XCTAssertLessThanOrEqual(input.utf16.count, 2_000) }
        XCTAssertEqual(result, outputs.last)
    }

    func testEachWindowAfterTheFirstCarriesTheSummaryOfEverythingBeforeIt() async throws {
        let (inputs, outputs, _) = try await windows(2_000) { _, call in "S\(call)" }
        XCTAssertFalse(inputs[0].contains(Self.next), "the first window is plain text")
        for i in 1..<inputs.count {
            XCTAssertTrue(inputs[i].hasPrefix("Summary of the earlier parts:\n\(outputs[i - 1])\n\n\(Self.next)"), "call \(i + 1)")
        }
    }

    func testEveryPageIsReadExactlyOnceInOrder() async throws {
        let (inputs, _, _) = try await windows(2_000) { _, call in "S\(call)" }
        XCTAssertEqual(Self.markers(inputs), Array(0..<Self.pages.count))
    }

    func testASummaryThatGrowsTooLongIsCondensedBeforeItCrowdsOutTheText() async throws {
        let (inputs, _, result) = try await windows(2_000) { input, _ in
            String(repeating: "kept. ", count: input.utf16.count / 7)
        }
        for input in inputs { XCTAssertLessThanOrEqual(input.utf16.count, 2_000) }
        XCTAssertTrue(inputs.contains { !$0.contains(Self.next) && $0.hasPrefix("kept.") }, "the summary was condensed")
        XCTAssertEqual(Self.markers(inputs), Array(0..<Self.pages.count), "no page is lost to condensing")
        XCTAssertFalse(result.isEmpty)
    }

    func testADocumentThatFitsOneWindowIsOneCallWithThePlainText() async throws {
        let calls = Recorder()
        let result = try await SummaryText.summariseInWindows(["A short page.", "Another page."], limit: 2_000) {
            await calls.add($0)
            return "ok"
        }
        let seen = await calls.calls
        XCTAssertEqual(seen, ["A short page.\n\nAnother page."])
        XCTAssertEqual(result, "ok")
    }

    func testAProviderSummarisesAPageRange() async throws {
        final class TextModel: PdfAiProvider, @unchecked Sendable {
            var prompts: [String] = []
            func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
                prompts.append(request.prompt)
                return PdfAiResponse(text: " A contract. ")
            }
        }
        let document = try await contract()
        let text = TextModel()
        guard case .answered(let result) = await ai(document, text).summaries.summarize(pages: 0...0) else {
            return XCTFail("expected a summary")
        }
        XCTAssertEqual(result.value, PdfSummary(text: "A contract.", pagesWithoutText: []))
        XCTAssertEqual(result.source, .customProvider)
        XCTAssertTrue(text.prompts.joined().contains("1. Parties"))
        XCTAssertFalse(text.prompts.joined().contains("12. Termination"))
        await document.close()
    }

    func testWithoutAProviderOrModelSummariesAreUnavailable() async throws {
        let document = try await contract()
        guard case .unavailable(let state) = await ai(document, nil).summaries.summarize() else {
            return XCTFail("expected unavailable")
        }
        XCTAssertEqual(state, .unavailable(.noProvider))
        await document.close()
    }
}
