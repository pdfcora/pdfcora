import Foundation
import os

/// Set at release by scripts/set-release-date.sh. The private half of the public key is
/// held outside this repository.
enum LicenseBuild {
    static let releaseDate = "2026-09-15"
    static let publicKey = "REPLACED_IN_TASK_12"
    static let revoked: Set<String> = []
}

/// The SDK's license. Without a key covering a feature, the feature still works and
/// its output carries a watermark.
public enum PdfLicense {
    private static let lock = NSLock()
    private static var context = LicenseContext(publicKey: LicenseBuild.publicKey, revoked: LicenseBuild.revoked,
                                                releaseDate: LicenseBuild.releaseDate,
                                                appIdentifier: Bundle.main.bundleIdentifier)
    private static var key: String?
    private static var current: PdfLicenseStatus = .trial(reason: .noKey, message: "no license key set")
    private static var warned = false
    private static let log = Logger(subsystem: "com.pdfiumkit", category: "license")

    /// Sets the license key. Call before opening documents. Never throws: a bad key
    /// leaves the SDK in trial mode, and ``status`` says why.
    public static func setKey(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        self.key = key
        current = LicenseKey.evaluate(key, context: context)
    }

    public static var status: PdfLicenseStatus {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    /// Logs once per process, the first time anything is watermarked.
    static func noteWatermark(_ detail: String) {
        lock.lock()
        let first = !warned
        warned = true
        lock.unlock()
        if first { log.warning("PdfiumKit: output is watermarked — \(detail, privacy: .public)") }
    }

    /// Test hook. Internal, so only `@testable` code reaches it.
    @discardableResult
    static func configureForTesting(publicKey: String? = nil, revoked: Set<String>? = nil,
                                    releaseDate: String? = nil, appIdentifier: String? = nil,
                                    key: String?? = .none) -> PdfLicenseStatus {
        lock.lock(); defer { lock.unlock() }
        if let publicKey { context.publicKey = publicKey }
        if let revoked { context.revoked = revoked }
        if let releaseDate { context.releaseDate = releaseDate }
        if let appIdentifier { context.appIdentifier = appIdentifier }
        if case .some(let value) = key { self.key = value }
        current = LicenseKey.evaluate(self.key, context: context)
        return current
    }
}
