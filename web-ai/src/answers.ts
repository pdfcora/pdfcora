import type { PdfDocument, PdfRect } from '@pdfcora/web';

import { locateQuote } from './quote.js';
import { retrieve } from './retrieval.js';
import { type PdfPassage, type PdfTextIndex, rectsForRange } from './text.js';

/** A sentence in the document that supports an answer (ANS-5). */
export interface PdfCitation {
  readonly pageIndex: number;
  /** Character range in the page's text layer, end exclusive. */
  readonly start: number;
  readonly end: number;
  readonly rects: readonly PdfRect[];
  /** The source text the range covers, not the model's copy of it. */
  readonly quote: string;
}

export type PdfAnswer =
  | {
      readonly kind: 'answered';
      readonly text: string;
      readonly citations: readonly PdfCitation[];
      /** False when any quote the model gave could not be found in the document (ANS-3). */
      readonly grounded: boolean;
      readonly pagesWithoutText: readonly number[];
    }
  | { readonly kind: 'notFound'; readonly pagesWithoutText: readonly number[] };

/** What the model is asked to return (ANS-2). */
export interface PdfGroundedReply {
  readonly answer: string;
  readonly citations: readonly { readonly passage: string; readonly quote: string }[];
}

export const MAX_CITATIONS = 3;

/** Characters per token, deliberately low so a prompt never overruns the budget. */
const CHARS_PER_TOKEN = 3;

export const groundedReplySchema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    citations: {
      type: 'array',
      maxItems: MAX_CITATIONS,
      items: {
        type: 'object',
        properties: { passage: { type: 'string' }, quote: { type: 'string' } },
        required: ['passage', 'quote'],
      },
    },
  },
  required: ['answer', 'citations'],
} as const;

/** The passages that fit a model with `contextTokens`, leaving room for the instructions and reply. */
export function passagesForBudget(index: PdfTextIndex, question: string, contextTokens: number): PdfPassage[] {
  return retrieve(index.passages, question, Math.floor(contextTokens * CHARS_PER_TOKEN * 0.6));
}

export function groundedPrompt(question: string, passages: readonly PdfPassage[]): string {
  return [
    'Answer the question using only the passages below.',
    `Support the answer with up to ${MAX_CITATIONS} citations. Each citation names a passage id and`,
    'quotes one sentence from that passage word for word.',
    'If the passages do not answer the question, reply with an empty answer and no citations.',
    '',
    'Passages:',
    // One line per passage: the page's own line breaks would blur where a passage ends.
    // Quotes are still checked against the original text, whitespace-tolerantly.
    ...passages.map((p) => `[${p.id}] (page ${p.pageIndex + 1}) ${p.text.replace(/\s+/g, ' ')}`),
    '',
    `Question: ${question}`,
  ].join('\n');
}

/** Reads a reply from structured output, or from text that holds JSON. Null if neither parses. */
export function parseReply(structured: unknown, text: string): PdfGroundedReply | null {
  let value = structured;
  if (value === undefined) {
    const json = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const { answer, citations } = value as { answer?: unknown; citations?: unknown };
  if (typeof answer !== 'string' || !Array.isArray(citations)) return null;
  return {
    answer,
    citations: citations
      .filter((c): c is { passage: string; quote: string } =>
        typeof c?.passage === 'string' && typeof c?.quote === 'string')
      .slice(0, MAX_CITATIONS),
  };
}

/**
 * Turns a model's reply into an answer whose highlights come only from verified quotes.
 *
 * A quote is looked for in the passage it names first, then in the other passages the
 * model was shown, and nowhere else. Apple's on-device model quotes accurately but often
 * names a passage that does not exist ("p1-3", or a heading), so the quote decides and the
 * id is only a hint. Coordinates are never taken from the model.
 *
 * With no citations at all there is nothing to verify, so the answer is `notFound`: the
 * same model replies "not mentioned in the passages" rather than the empty answer asked for.
 */
export async function verifyReply(
  document: PdfDocument, index: PdfTextIndex, passages: readonly PdfPassage[], reply: PdfGroundedReply,
): Promise<PdfAnswer> {
  if (reply.citations.length === 0) {
    return { kind: 'notFound', pagesWithoutText: index.pagesWithoutText };
  }

  const citations: PdfCitation[] = [];
  let verified = 0;
  for (const cited of reply.citations) {
    const named = passages.filter((p) => p.id === cited.passage);
    let passage: PdfPassage | undefined;
    let found: { start: number; end: number } | null = null;
    for (const candidate of [...named, ...passages.filter((p) => p.id !== cited.passage)]) {
      found = locateQuote(candidate.text, cited.quote);
      if (found) { passage = candidate; break; }
    }
    if (!passage || !found) continue;
    verified++;
    const start = passage.start + found.start;
    const end = passage.start + found.end;
    // A model may cite one sentence several times; it is one highlight.
    if (citations.some((c) => c.pageIndex === passage!.pageIndex && c.start === start && c.end === end)) continue;
    const page = index.pages.find((p) => p.pageIndex === passage.pageIndex)!;
    citations.push({
      pageIndex: passage.pageIndex,
      start,
      end,
      rects: await rectsForRange(document, passage.pageIndex, start, end),
      quote: page.text.slice(start, end),
    });
  }

  return {
    kind: 'answered',
    text: reply.answer,
    citations,
    grounded: verified === reply.citations.length,
    pagesWithoutText: index.pagesWithoutText,
  };
}
