import { sentencesOf } from './text.js';

export type PdfSummaryStyle = 'paragraph' | 'keyPoints';

export interface PdfSummary {
  readonly text: string;
  readonly pagesWithoutText: readonly number[];
}

const EARLIER = 'Summary of the earlier parts:\n';
const NEXT = '\n\nNext part:\n';

/**
 * Summarises text of any length with a summariser that accepts at most `limitChars` at a
 * time (SUM-2), reading it in windows.
 *
 * The first window is plain text. Each later window carries the summary so far followed by
 * the next stretch of text, so each part is summarised knowing what came before, and the
 * last summary covers the whole document. Text is split at sentences into pieces of at most
 * a quarter of the limit, and a summary that would leave no room for a piece is condensed
 * first — and cut, if condensing does not shrink it enough.
 */
export async function summariseInWindows(
  pages: readonly string[],
  limitChars: number,
  summarise: (text: string) => Promise<string>,
): Promise<string> {
  const pieceChars = Math.max(1, Math.floor(limitChars / 4));
  const pieces = pages.flatMap((page) => split(page, pieceChars));
  let summary: string | null = null;
  let next = 0;

  while (next < pieces.length) {
    if (summary !== null && EARLIER.length + summary.length + NEXT.length + pieceChars > limitChars) {
      summary = collapseBullets(await summarise(summary.slice(0, limitChars)));
      summary = summary.slice(0, Math.max(0, limitChars - EARLIER.length - NEXT.length - pieceChars));
    }
    const room = limitChars - (summary === null ? 0 : EARLIER.length + summary.length + NEXT.length);
    let window = '';
    while (next < pieces.length) {
      const joined = window ? `${window}\n\n${pieces[next]}` : pieces[next]!;
      if (joined.length > room) break;
      window = joined;
      next++;
    }
    summary = collapseBullets(await summarise(summary === null ? window : `${EARLIER}${summary}${NEXT}${window}`));
  }
  return summary ?? '';
}

/**
 * Given a bulleted summary to carry forward, a model may bullet its lines again: Apple's
 * returns "- - point". Two or more markers opening a line become one.
 */
function collapseBullets(text: string): string {
  return text.replace(/^[ \t]*(?:[-*•][ \t]+){2,}/gm, '- ');
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
