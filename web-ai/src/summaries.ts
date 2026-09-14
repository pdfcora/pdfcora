import { sentencesOf } from './text.js';

export type PdfSummaryStyle = 'paragraph' | 'keyPoints';

export interface PdfSummary {
  readonly text: string;
  readonly pagesWithoutText: readonly number[];
}

/**
 * Summarises text of any length with a summariser that accepts at most `limitChars` at a
 * time (SUM-2).
 *
 * Pages are packed into parts that fit, each part is summarised, and the summaries are
 * combined the same way until one call covers everything. A single page too long for
 * the limit is split at sentence boundaries, and a sentence too long at the limit itself.
 */
export async function summariseWithin(
  pages: readonly string[],
  limitChars: number,
  summarise: (text: string) => Promise<string>,
): Promise<string> {
  let parts = pack(pages.flatMap((page) => split(page, limitChars)), limitChars);
  if (parts.length === 0) return '';
  while (parts.length > 1) {
    const summaries: string[] = [];
    for (const part of parts) summaries.push(await summarise(part));
    const next = pack(summaries.flatMap((s) => split(s, limitChars)), limitChars);
    // Summaries that no longer shrink would loop forever; a summariser that returns its
    // input is broken, and the best available answer is to stop.
    if (next.join('').length >= parts.join('').length) {
      parts = [next.join('\n\n').slice(0, limitChars)];
      break;
    }
    parts = next;
  }
  return summarise(parts[0]!);
}

function pack(pieces: readonly string[], limitChars: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length <= limitChars) {
      current = joined;
    } else {
      if (current) parts.push(current);
      current = piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function split(text: string, limitChars: number): string[] {
  if (text.length <= limitChars) return text.trim() ? [text] : [];
  const pieces: string[] = [];
  for (const { start, end } of sentencesOf(text)) {
    for (let at = start; at < end; at += limitChars) pieces.push(text.slice(at, Math.min(end, at + limitChars)));
  }
  return pieces;
}

export function summaryPrompt(text: string, style: PdfSummaryStyle): string {
  return [
    style === 'keyPoints'
      ? 'Summarise the text below as key points, one per line, each starting with "- ".'
      : 'Summarise the text below as one short paragraph.',
    'Use only what the text says.',
    '',
    text,
  ].join('\n');
}
