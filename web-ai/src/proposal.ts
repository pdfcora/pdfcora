import type { PdfAiSource } from './provider.js';

export type PdfProposalKind = 'formValue' | 'altText' | 'redaction' | 'tag';

/** A change the user has not agreed to yet. */
export interface PdfProposal<T> {
  readonly id: string;
  readonly kind: PdfProposalKind;
  readonly detail: T;
  readonly source: PdfAiSource;
}

export interface PdfProposalSet<T> {
  readonly proposals: readonly PdfProposal<T>[];
  /** How one proposal is written. Called only from `applyProposals`. */
  readonly write: (proposal: PdfProposal<T>) => Promise<void>;
}

export function proposalSet<T>(
  proposals: readonly PdfProposal<T>[],
  write: (proposal: PdfProposal<T>) => Promise<void>,
): PdfProposalSet<T> {
  return { proposals, write };
}

/**
 * Writes exactly the proposals the user accepted, in the order they were proposed.
 *
 * Every id is checked before anything is written, so a set containing one bad id leaves
 * the document untouched rather than half-applied. An unknown id is an error rather than
 * a no-op: it means the host and the SDK disagree about what was on screen, and silently
 * writing nothing would look like success.
 */
export async function applyProposals<T>(
  set: PdfProposalSet<T>,
  acceptedIds: readonly string[],
): Promise<void> {
  const byId = new Map(set.proposals.map((p) => [p.id, p]));
  for (const id of acceptedIds) {
    if (!byId.has(id)) throw new Error(`unknown proposal: ${id}`);
  }

  const accepted = new Set(acceptedIds);
  for (const proposal of set.proposals) {
    if (accepted.has(proposal.id)) await set.write(proposal);
  }
}
