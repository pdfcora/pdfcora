import type { PdfDocument, PdfRect } from '@pdfiumkit/web';

/** One page's text layer, with the characters' positions available through the core. */
export interface PdfPageText {
  readonly pageIndex: number;
  readonly text: string;
}

/** A retrievable piece of a page: whole sentences, with their character range. */
export interface PdfPassage {
  readonly id: string;
  readonly pageIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface PdfTextIndex {
  readonly pages: readonly PdfPageText[];
  readonly passages: readonly PdfPassage[];
  /** Pages with no text layer, which could not be searched (ANS-6). */
  readonly pagesWithoutText: readonly number[];
}

export interface PdfPageRange {
  readonly from: number;
  /** Inclusive. */
  readonly to: number;
}

/** Passages are whole sentences up to about this many characters. */
const PASSAGE_CHARS = 600;

/** Reads each page's text layer. Pages whose text is only whitespace count as having none. */
export async function readPages(document: PdfDocument, range?: PdfPageRange): Promise<{
  pages: PdfPageText[];
  pagesWithoutText: number[];
}> {
  const count = await document.pageCount();
  const from = Math.max(0, range?.from ?? 0);
  const to = Math.min(count - 1, range?.to ?? count - 1);
  const pages: PdfPageText[] = [];
  const pagesWithoutText: number[] = [];
  for (let pageIndex = from; pageIndex <= to; pageIndex++) {
    const text = await (await document.page(pageIndex)).text.string();
    if (text.trim().length === 0) pagesWithoutText.push(pageIndex);
    else pages.push({ pageIndex, text });
  }
  return { pages, pagesWithoutText };
}

export async function indexDocument(document: PdfDocument): Promise<PdfTextIndex> {
  const { pages, pagesWithoutText } = await readPages(document);
  return { pages, passages: pages.flatMap(passagesOf), pagesWithoutText };
}

/** Splits a page into sentence-aligned passages, keeping each one's character range. */
export function passagesOf(page: PdfPageText): PdfPassage[] {
  const passages: PdfPassage[] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start < 0) return;
    passages.push({
      id: `p${page.pageIndex}-${passages.length}`,
      pageIndex: page.pageIndex,
      start,
      end,
      text: page.text.slice(start, end),
    });
    start = -1;
  };

  for (const sentence of sentencesOf(page.text)) {
    if (start >= 0 && sentence.end - start > PASSAGE_CHARS) flush();
    if (start < 0) start = sentence.start;
    end = sentence.end;
  }
  flush();
  return passages;
}

/** Sentence ranges, trimmed of surrounding whitespace. */
export function sentencesOf(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const boundary = /[.!?](?=\s|$)|\n\s*\n/g;
  let cursor = 0;
  const push = (from: number, to: number) => {
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    if (to > from) ranges.push({ start: from, end: to });
  };
  for (const match of text.matchAll(boundary)) {
    const to = match.index! + match[0].length;
    push(cursor, to);
    cursor = to;
  }
  push(cursor, text.length);
  return ranges;
}

/**
 * Rectangles covering a character range, one per line.
 *
 * Built from the core's per-character boxes. Characters PDFium generates for layout, such
 * as line breaks, have empty boxes and are skipped.
 */
export async function rectsForRange(
  document: PdfDocument, pageIndex: number, start: number, end: number,
): Promise<PdfRect[]> {
  const text = (await document.page(pageIndex)).text;
  const rects: PdfRect[] = [];
  for (let i = start; i < end; i++) {
    const box = await text.boundingBox(i);
    if (box.right <= box.left || box.top <= box.bottom) continue;
    const line = rects[rects.length - 1];
    if (line && sameLine(line, box)) {
      rects[rects.length - 1] = {
        left: Math.min(line.left, box.left), right: Math.max(line.right, box.right),
        bottom: Math.min(line.bottom, box.bottom), top: Math.max(line.top, box.top),
      };
    } else {
      rects.push(box);
    }
  }
  return rects;
}

function sameLine(a: PdfRect, b: PdfRect): boolean {
  const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom);
  return overlap > 0.5 * Math.min(a.top - a.bottom, b.top - b.bottom) && b.left >= a.left - 1;
}
