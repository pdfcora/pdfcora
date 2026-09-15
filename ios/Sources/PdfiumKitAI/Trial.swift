import Foundation
import os
import PdfiumKit

/// Marks model output produced without an `ai` license. Quotes are never touched, so
/// grounding still verifies.
enum Trial {
    static let prefix = "PdfiumKit trial — "
    private static let lock = NSLock()
    private static var warned = false

    static func mark(_ outcome: PdfAiOutcome<PdfAnswer>,
                     licensed: Bool = PdfLicense.status.covers(.ai)) -> PdfAiOutcome<PdfAnswer> {
        guard !licensed, case .answered(let result) = outcome,
              case .answered(let text, let citations, let grounded, let pages) = result.value else { return outcome }
        warn()
        return .answered(PdfAiResult(value: .answered(text: prefix + text, citations: citations,
                                                      grounded: grounded, pagesWithoutText: pages),
                                     source: result.source))
    }

    static func mark(_ outcome: PdfAiOutcome<PdfSummary>,
                     licensed: Bool = PdfLicense.status.covers(.ai)) -> PdfAiOutcome<PdfSummary> {
        guard !licensed, case .answered(let result) = outcome else { return outcome }
        warn()
        return .answered(PdfAiResult(value: PdfSummary(text: prefix + result.value.text,
                                                       pagesWithoutText: result.value.pagesWithoutText),
                                     source: result.source))
    }

    /// A notice or other SDK text shown without an `ai` license gets the same prefix as model output.
    static func text(_ value: String, licensed: Bool = PdfLicense.status.covers(.ai)) -> String {
        licensed ? value : prefix + value
    }

    private static func warn() {
        lock.lock()
        let first = !warned
        warned = true
        lock.unlock()
        if first {
            Logger(subsystem: "com.pdfiumkit", category: "license")
                .warning("PdfiumKit: AI output is marked as trial — the license key does not include the ai module")
        }
    }
}
