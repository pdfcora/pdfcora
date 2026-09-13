import Foundation

/// Where an answer came from. Shown to users and logged for audits (PRV-3).
public enum PdfAiSource: Equatable, Sendable {
    case onDevice, customProvider, rules
}

public struct PdfAiResult<T: Sendable>: Sendable {
    public let value: T
    public let source: PdfAiSource
}

public struct PdfAiRequest: Sendable {
    public let prompt: String
    /// Encoded images, for providers that accept them. Apple's model does not: as of
    /// iOS 26.4 `FoundationModels` takes text only.
    public let images: [Data]
    /// JSON Schema for structured output, when the feature needs one.
    public let schema: String?

    public init(prompt: String, images: [Data] = [], schema: String? = nil) {
        self.prompt = prompt
        self.images = images
        self.schema = schema
    }
}

public struct PdfAiResponse: Sendable {
    public let text: String
    public let structured: String?

    public init(text: String, structured: String? = nil) {
        self.text = text
        self.structured = structured
    }
}

/// Implemented by the integrator: their own server, or their own model.
public protocol PdfAiProvider: Sendable {
    func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse
}

/// One attempt at an answer. `nil` means "no answer"; throwing means "broke".
public typealias PdfAiRoute<T> = @Sendable () async throws -> T?

/// The outcome of resolving the routes: an answer, or why there wasn't one.
public enum PdfAiOutcome<T: Sendable>: Sendable {
    case answered(PdfAiResult<T>)
    case unavailable(PdfAiAvailability)
}

/// Tries each route in the fixed order of PRV-2 and reports which one answered.
///
/// A route returning nil and a route throwing are treated the same — both move on to
/// the next route — because a custom provider is someone else's server, and its outage
/// must not take down a feature that has a rules fallback.
public func resolveRoutes<T: Sendable>(
    onDevice: PdfAiRoute<T>? = nil,
    customProvider: PdfAiRoute<T>? = nil,
    rules: PdfAiRoute<T>? = nil
) async -> PdfAiOutcome<T> {
    let ordered: [(PdfAiSource, PdfAiRoute<T>?)] = [
        (.onDevice, onDevice), (.customProvider, customProvider), (.rules, rules),
    ]

    for (source, route) in ordered {
        guard let route else { continue }
        if let value = try? await route() {
            return .answered(PdfAiResult(value: value, source: source))
        }
    }
    return .unavailable(.unavailable(.noProvider))
}
