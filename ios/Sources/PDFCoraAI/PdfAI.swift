import Foundation
import PDFCora

public struct PdfAIOptions: Sendable {
    public let provider: PdfAiProvider?
    /// The custom provider's context window in tokens. Apple's model reports its own;
    /// a custom provider cannot, so it is the integrator's to state.
    public let providerContextTokens: Int
    /// Alpha prompt APIs stay off unless asked for (PRV-5).
    public let experimentalOnDevicePrompt: Bool
    /// Tests turn the Apple model off: a simulator reports it usable on some calls and
    /// not others, which would make every provider test a coin toss.
    var allowsOnDevice = true

    public init(provider: PdfAiProvider? = nil, providerContextTokens: Int = 4096,
                experimentalOnDevicePrompt: Bool = false) {
        self.provider = provider
        self.providerContextTokens = providerContextTokens
        self.experimentalOnDevicePrompt = experimentalOnDevicePrompt
    }
}

/// The entry point. One instance per document.
///
/// Every feature reports availability separately (AVL-2) and re-checks it on each call
/// (AVL-3), because the user can turn the platform's AI off mid-session.
public struct PdfAI: Sendable {
    /// The document this instance answers about. Only the core's public API is used (PKG-4).
    public let document: PdfDocument
    public let options: PdfAIOptions
    private let cache = IndexCache()

    public init(document: PdfDocument, options: PdfAIOptions = .init()) {
        self.document = document
        self.options = options
    }

    /// Answers questions from the document, citing the sentences they came from (ANS).
    public var answers: Answers { Answers(ai: self) }

    /// Summarises the document or a page range (SUM).
    public var summaries: Summaries { Summaries(ai: self) }

    /// One reading of the Apple model for this call, or nil when tests have ruled it out.
    func appleReading() -> AppleModel.Reading? {
        options.allowsOnDevice ? AppleModel.read() : nil
    }

    fileprivate func availability(_ apple: AppleModel.Reading?) -> PdfAiAvailability {
        if apple?.isPromptable == true || options.provider != nil { return .available }
        guard let apple else { return .unavailable(.noProvider) }
        // Available but with no prompt budget is a model still loading.
        return apple.availability.isUsable ? .unavailable(.modelNotReady) : apple.availability
    }

    public struct Answers: Sendable {
        let ai: PdfAI

        public func availability() -> PdfAiAvailability {
            ai.availability(ai.appleReading())
        }

        public func ask(_ question: String) async -> PdfAiOutcome<PdfAnswer> {
            let apple = ai.appleReading()
            let state = ai.availability(apple)
            guard state.isUsable else { return .unavailable(state) }
            guard let index = try? await ai.cache.index(ai.document) else {
                return .unavailable(.unavailable(.noProvider))
            }

            let provider = ai.options.provider
            let providerTokens = ai.options.providerContextTokens
            let appleTokens = apple?.isPromptable == true ? apple?.contextTokens : nil

            // ANS-4: no relevant passage means no model call at all. Relevance does not
            // depend on the budget, so the largest one decides.
            let largest = max(appleTokens ?? 0, provider != nil ? providerTokens : 0)
            if GroundedAnswers.passages(index, question: question, contextTokens: largest).isEmpty {
                return .answered(PdfAiResult(value: .notFound(pagesWithoutText: index.pagesWithoutText),
                                             source: .rules))
            }

            let document = ai.document
            return await resolveRoutes(
                onDevice: appleTokens.map { tokens in {
                    let passages = GroundedAnswers.passages(index, question: question, contextTokens: tokens)
                    guard let reply = try await AppleModel.groundedReply(
                        to: GroundedAnswers.prompt(question: question, passages: passages)) else { return nil }
                    return try await GroundedAnswers.verify(reply, document: document, index: index, passages: passages)
                } },
                customProvider: provider.map { provider in {
                    let passages = GroundedAnswers.passages(index, question: question, contextTokens: providerTokens)
                    let response = try await provider.generate(PdfAiRequest(
                        prompt: GroundedAnswers.prompt(question: question, passages: passages),
                        schema: GroundedAnswers.schema))
                    guard let reply = GroundedAnswers.parse(structured: response.structured, text: response.text)
                    else { return nil }
                    return try await GroundedAnswers.verify(reply, document: document, index: index, passages: passages)
                } })
        }
    }

    public struct Summaries: Sendable {
        let ai: PdfAI

        /// `language` is a BCP 47 code. When the on-device model does not support it, the
        /// feature is unavailable rather than producing a poor summary (SUM-3).
        public func availability(language: String? = nil) -> PdfAiAvailability {
            if let language, ai.options.allowsOnDevice, AppleModel.supports(language: language) == false {
                return .unavailable(.languageNotSupported)
            }
            return ai.availability(ai.appleReading())
        }

        /// Apple manages its own model, so there is nothing to download beyond reporting
        /// the result. Exists for the host to call, and nothing else calls it (AVL-4).
        public func prepare(onProgress: (@Sendable (Double) -> Void)? = nil) async -> PdfAiAvailability {
            onProgress?(1)
            return availability()
        }

        public func summarize(pages: ClosedRange<Int>? = nil, style: PdfSummaryStyle = .paragraph,
                              language: String? = nil) async -> PdfAiOutcome<PdfSummary> {
            let state = availability(language: language)
            guard state.isUsable else { return .unavailable(state) }
            guard let (pageTexts, pagesWithoutText) = try? await TextLayer.readPages(ai.document, range: pages) else {
                return .unavailable(.unavailable(.noProvider))
            }
            let texts = pageTexts.map(\.text)
            let apple = ai.appleReading()
            let appleTokens = apple?.isPromptable == true ? apple?.contextTokens : nil
            let provider = ai.options.provider
            let providerTokens = ai.options.providerContextTokens
            func limit(_ tokens: Int) -> Int { Int(Double(tokens * GroundedAnswers.charsPerToken) * 0.6) }

            return await resolveRoutes(
                onDevice: appleTokens.map { tokens in {
                    let text = try await SummaryText.summariseInWindows(texts, limit: limit(tokens)) { part in
                        try await AppleModel.respond(to: SummaryText.prompt(part, style: style)) ?? ""
                    }
                    return PdfSummary(text: text, pagesWithoutText: pagesWithoutText)
                } },
                customProvider: provider.map { provider in {
                    let text = try await SummaryText.summariseInWindows(texts, limit: limit(providerTokens)) { part in
                        try await provider.generate(PdfAiRequest(prompt: SummaryText.prompt(part, style: style)))
                            .text.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                    return PdfSummary(text: text, pagesWithoutText: pagesWithoutText)
                } })
        }
    }
}

/// Builds the text index once per `PdfAI` value and shares it between calls.
private actor IndexCache {
    private var task: Task<PdfTextIndex, Error>?

    func index(_ document: PdfDocument) async throws -> PdfTextIndex {
        if let task { return try await task.value }
        let task = Task { try await TextLayer.index(document) }
        self.task = task
        return try await task.value
    }
}
