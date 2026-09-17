package com.pdfcora.ai

enum class PdfProposalKind { FORM_VALUE, ALT_TEXT, REDACTION, TAG }

/** A change the user has not agreed to yet. */
data class PdfProposal<T>(
    val id: String,
    val kind: PdfProposalKind,
    val detail: T,
    val source: PdfAiSource,
)

class UnknownProposalException(id: String) : IllegalArgumentException("unknown proposal: $id")

class PdfProposalSet<T>(
    val proposals: List<PdfProposal<T>>,
    /** How one proposal is written. Called only from [apply]. */
    private val write: suspend (PdfProposal<T>) -> Unit,
) {
    /**
     * Writes exactly the proposals the user accepted, in the order they were proposed.
     *
     * Every id is checked before anything is written, so a set containing one bad id
     * leaves the document untouched rather than half-applied. An unknown id is an error
     * rather than a no-op: it means the host and the SDK disagree about what was on
     * screen, and silently writing nothing would look like success.
     */
    suspend fun apply(accepting: List<String>) {
        val known = proposals.map { it.id }.toSet()
        accepting.firstOrNull { it !in known }?.let { throw UnknownProposalException(it) }

        val accepted = accepting.toSet()
        proposals.filter { it.id in accepted }.forEach { write(it) }
    }
}
