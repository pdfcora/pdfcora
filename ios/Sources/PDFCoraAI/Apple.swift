import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// The Apple on-device model, behind every availability check it needs.
///
/// `FoundationModels` requires iOS 26. The package itself supports iOS 15 (PKG-3), so
/// every use sits behind both `#if canImport` and `#available`, and an older OS reports
/// `platformUnsupported` rather than failing to launch.
public enum AppleModel {
    /// Re-checked on every call (AVL-3): the user can turn Apple Intelligence off while
    /// the app is running.
    public static func availability() -> PdfAiAvailability {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            return PdfAiAvailability(apple: SystemLanguageModel.default.availability)
        }
        #endif
        return .unavailable(.platformUnsupported)
    }

    /// The prompt budget, taken from the OS rather than a constant so it follows the
    /// platform when Apple changes it.
    ///
    /// `nil` when there is no usable budget — which is **not** the same as the model
    /// being unavailable. An iOS 27 simulator reports `.available` and a `contextSize`
    /// of `0`; a feature that trusted availability alone would build a zero-token
    /// prompt. Anything not positive is reported as no budget so callers fall through
    /// to their next route.
    public static func contextTokens() -> Int? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let size = SystemLanguageModel.default.contextSize
            return size > 0 ? size : nil
        }
        #endif
        return nil
    }

    /// One reading of the model's state.
    ///
    /// Sampled together and passed around as a unit. The platform's answers are *not*
    /// stable between calls — a simulator will report `.available` with a budget of `0`
    /// on one call and a real budget on the next, as the model loads — so a decision
    /// made by querying twice can contradict itself.
    public struct Reading: Equatable, Sendable {
        public let availability: PdfAiAvailability
        /// `nil` when there is no usable budget.
        public let contextTokens: Int?

        /// Whether the model can actually be prompted.
        ///
        /// Both conditions must hold: the platform says available, *and* it reports a
        /// budget to fit a prompt into. Availability alone is not enough.
        public var isPromptable: Bool { availability.isUsable && contextTokens != nil }
    }

    /// Takes one reading. Call this per operation (AVL-3), and decide from the result
    /// rather than re-querying.
    public static func read() -> Reading {
        Reading(availability: availability(), contextTokens: contextTokens())
    }

    /// Whether the on-device model accepts images.
    ///
    /// False on every shipping OS: as of iOS 26.4 the only conformances to
    /// `PromptRepresentable` are `String`, `Prompt`, `Array` and
    /// `ConvertibleToGeneratedContent`. Alt text therefore has no Apple on-device route
    /// and falls back to the custom provider, as it does on Web.
    public static var acceptsImages: Bool { false }
}

extension AppleModel {
    /// Asks the on-device model for a grounded answer with guided generation (ANS-2).
    /// Nil when the model cannot be prompted on this OS.
    static func groundedReply(to prompt: String) async throws -> PdfGroundedReply? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let reply = try await LanguageModelSession().respond(to: prompt, generating: AppleGroundedReply.self).content
            return PdfGroundedReply(answer: reply.answer,
                                    citations: reply.citations.map { .init(passage: $0.passage, quote: $0.quote) })
        }
        #endif
        return nil
    }

    /// Plain text from the on-device model. Nil when it cannot be prompted on this OS.
    static func respond(to prompt: String) async throws -> String? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            return try await LanguageModelSession().respond(to: prompt).content
        }
        #endif
        return nil
    }

    /// Whether the model supports a BCP 47 language. Nil when there is no model to ask.
    static func supports(language: String) -> Bool? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let code = Locale.Language(identifier: language).languageCode
            return SystemLanguageModel.default.supportedLanguages.contains { $0.languageCode == code }
        }
        #endif
        return nil
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
@Generable
struct AppleGroundedReply {
    @Guide(description: "The answer, from the passages only. Empty if they do not answer the question.")
    var answer: String
    @Guide(description: "Sentences supporting the answer, each quoted word for word from one passage.", .maximumCount(3))
    var citations: [AppleCitation]
}

@available(iOS 26.0, macOS 26.0, *)
@Generable
struct AppleCitation {
    @Guide(description: "The id of the passage the quote comes from, such as p1-0.")
    var passage: String
    @Guide(description: "One sentence copied word for word from that passage.")
    var quote: String
}
#endif

#if canImport(FoundationModels)
@available(iOS 26.0, macOS 26.0, *)
extension PdfAiAvailability {
    /// Apple reports two states; this vocabulary has four.
    ///
    /// `downloadable` and `downloading` have no Apple equivalent — the system manages
    /// the model — so they are never produced here rather than being faked.
    init(apple: SystemLanguageModel.Availability) {
        switch apple {
        case .available:
            self = .available
        case .unavailable(let reason):
            switch reason {
            case .deviceNotEligible: self = .unavailable(.deviceNotEligible)
            case .appleIntelligenceNotEnabled: self = .unavailable(.notEnabled)
            case .modelNotReady: self = .unavailable(.modelNotReady)
            @unknown default: self = .unavailable(.platformUnsupported)
            }
        }
    }
}
#endif
