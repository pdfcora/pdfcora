import Foundation

/// Why a feature cannot run.
public enum PdfAiUnavailableReason: Equatable, Sendable {
    /// The hardware cannot run it.
    case deviceNotEligible
    /// The user turned the platform's AI off.
    case notEnabled
    /// Present but not loaded yet.
    case modelNotReady
    /// No such API on this OS.
    case platformUnsupported
    /// The document's language is not supported by the platform.
    case languageNotSupported
    /// No on-device route and no custom provider configured.
    case noProvider
    /// A model or provider was tried and failed, and no other route answered.
    case requestFailed
    /// The platform refuses on-device inference while the app is in the background.
    case backgroundUseBlocked
}

/// Whether a feature can run right now.
///
/// A superset of what any one platform reports. Apple has only ``available`` and
/// ``unavailable(_:)``; Android and Web genuinely distinguish a model that could be
/// downloaded from one that is downloading. ``downloadable`` and ``downloading`` are
/// therefore unreachable on Apple platforms, by design — see ``AppleModel``.
public enum PdfAiAvailability: Equatable, Sendable {
    case available
    case downloadable
    case downloading(progress: Double?)
    case unavailable(PdfAiUnavailableReason)

    public var isUsable: Bool {
        if case .available = self { return true }
        return false
    }
}
