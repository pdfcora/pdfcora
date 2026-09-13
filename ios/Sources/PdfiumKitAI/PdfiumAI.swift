import Foundation
import PdfiumKit

public struct PdfiumAIOptions: Sendable {
    public let provider: PdfAiProvider?
    /// Alpha prompt APIs stay off unless asked for (PRV-5).
    public let experimentalOnDevicePrompt: Bool

    public init(provider: PdfAiProvider? = nil, experimentalOnDevicePrompt: Bool = false) {
        self.provider = provider
        self.experimentalOnDevicePrompt = experimentalOnDevicePrompt
    }
}

/// The entry point. One instance per document.
///
/// Every feature reports availability separately (AVL-2) and re-checks it on each call
/// (AVL-3), because the user can turn the platform's AI off mid-session.
public struct PdfiumAI: Sendable {
    /// The document this instance answers about. Only the core's public API is used
    /// (PKG-4).
    public let document: PdfDocument
    public let options: PdfiumAIOptions

    public init(document: PdfDocument, options: PdfiumAIOptions = .init()) {
        self.document = document
        self.options = options
    }

    /// A feature that does nothing, so the not-available path can be exercised before
    /// any real feature exists. Delete it when Phase 1 lands.
    public var stub: Stub { Stub(options: options) }

    public struct Stub: Sendable {
        let options: PdfiumAIOptions

        public func availability() -> PdfAiAvailability {
            // Apple is the one platform with a general on-device model, so unlike Web
            // the honest answer here depends on the device rather than being a flat no.
            let onDevice = AppleModel.availability()
            if onDevice.isUsable { return .available }
            return options.provider != nil ? .available : onDevice
        }

        /// Asks the platform to fetch the model. AVL-4 forbids the SDK starting a
        /// download on its own, so this exists to be called by the host and nowhere
        /// else. Apple manages its own model, so there is nothing to drive here beyond
        /// reporting the result.
        public func prepare(onProgress: (@Sendable (Double) -> Void)? = nil) async -> PdfAiAvailability {
            onProgress?(1)
            return availability()
        }

        public func run() async -> PdfAiOutcome<String> {
            await resolveRoutes(
                customProvider: {
                    guard let provider = options.provider else { return nil }
                    return try await provider.generate(PdfAiRequest(prompt: "ping")).text
                })
        }
    }
}
