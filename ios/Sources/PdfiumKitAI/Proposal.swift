import Foundation

public enum PdfProposalKind: Equatable, Sendable {
    case formValue, altText, redaction, tag
}

/// A change the user has not agreed to yet.
public struct PdfProposal<T: Sendable>: Sendable {
    public let id: String
    public let kind: PdfProposalKind
    public let detail: T
    public let source: PdfAiSource

    public init(id: String, kind: PdfProposalKind, detail: T, source: PdfAiSource) {
        self.id = id
        self.kind = kind
        self.detail = detail
        self.source = source
    }
}

public enum PdfProposalError: Error, Equatable {
    case unknownProposal(String)
}

public struct PdfProposalSet<T: Sendable>: Sendable {
    public let proposals: [PdfProposal<T>]
    /// How one proposal is written. Called only from ``apply(accepting:)``.
    let write: @Sendable (PdfProposal<T>) async throws -> Void

    public init(
        _ proposals: [PdfProposal<T>],
        write: @escaping @Sendable (PdfProposal<T>) async throws -> Void
    ) {
        self.proposals = proposals
        self.write = write
    }

    /// Writes exactly the proposals the user accepted, in the order they were proposed.
    ///
    /// Every id is checked before anything is written, so a set containing one bad id
    /// leaves the document untouched rather than half-applied. An unknown id is an error
    /// rather than a no-op: it means the host and the SDK disagree about what was on
    /// screen, and silently writing nothing would look like success.
    public func apply(accepting acceptedIds: [String]) async throws {
        let known = Set(proposals.map(\.id))
        for id in acceptedIds where !known.contains(id) {
            throw PdfProposalError.unknownProposal(id)
        }

        let accepted = Set(acceptedIds)
        for proposal in proposals where accepted.contains(proposal.id) {
            try await write(proposal)
        }
    }
}
