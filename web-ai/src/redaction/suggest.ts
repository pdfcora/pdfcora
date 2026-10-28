import type { PdfDocument, PdfRect, PdfRedactionReport } from '@pdfcora/web';
import { findPatterns, PATTERN_CATEGORIES, type PdfPatternCategory } from './patterns.js';
import { locateQuote } from '../quote.js';
import { readPages, rectsForRange, sentencesOf, type PdfPageRange, type PdfPageText } from '../text.js';
import { resolve, type PdfAiProvider, type PdfAiSource } from '../provider.js';

export type PdfModelRedactionCategory = 'personName' | 'postalAddress' | 'dateOfBirth' | 'idNumber';
export type PdfRedactionCategory = PdfPatternCategory | PdfModelRedactionCategory;
export const MODEL_CATEGORIES: readonly PdfModelRedactionCategory[] = ['personName', 'postalAddress', 'dateOfBirth', 'idNumber'];
export const REDACTION_NOTICE = 'Suggestions may be incomplete. Review the whole document.';

export interface PdfRedactionSuggestion {
  readonly id: string;
  readonly category: PdfRedactionCategory;
  readonly source: PdfAiSource;
  readonly pageIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly rects: readonly PdfRect[];
}

export interface PdfRedactionOptions {
  readonly pages?: PdfPageRange;
  readonly categories?: readonly PdfRedactionCategory[];
}

export interface PdfRedactionApplied {
  readonly report: PdfRedactionReport;
  /** Accepted suggestions whose text is still on the page. Empty unless something went wrong. */
  readonly remaining: readonly PdfRedactionSuggestion[];
  /** Reopens the document as it was before `apply`. The host shows it and closes the redacted one. */
  undo(): Promise<PdfDocument>;
}

export interface PdfRedactionReview {
  readonly suggestions: readonly PdfRedactionSuggestion[];
  /** False when no model answered, so only patterns ran. */
  readonly modelUsed: boolean;
  /** Must be shown with the suggestions (RED-4). */
  readonly notice: string;
  readonly pagesWithoutText: readonly number[];
  apply(acceptedIds: readonly string[]): Promise<PdfRedactionApplied>;
}

export const redactionSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { category: { type: 'string', enum: MODEL_CATEGORIES }, quote: { type: 'string' } },
        required: ['category', 'quote'],
      },
    },
  },
  required: ['items'],
};

export function redactionPrompt(text: string): string {
  return [
    'Find personal data in the text below.',
    'Categories: personName (the name of a person, not a company), postalAddress (a street address with a postal code or city),',
    'dateOfBirth (a date the text says is a birth date), idNumber (a passport, national ID, social security or tax number).',
    'Copy each quote exactly as it appears in the text. Reply with JSON: {"items": [{"category": "...", "quote": "..."}]}.',
    'Reply with {"items": []} when there is none.',
    '',
    text,
  ].join('\n');
}

/** Every place `quote` occurs in `text`, with the same tolerance as quote verification. */
export function occurrences(text: string, quote: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let offset = 0;
  for (;;) {
    const at = locateQuote(text.slice(offset), quote);
    if (!at) return found;
    found.push({ start: offset + at.start, end: offset + at.end });
    offset += at.end;
  }
}

interface Chunk { readonly pageIndex: number; readonly text: string }

/** Page text in pieces of at most `limit` characters, split between sentences. */
function chunksOf(pages: readonly PdfPageText[], limit: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    let current = '';
    for (const { start, end } of sentencesOf(page.text)) {
      const sentence = page.text.slice(start, end);
      if (current && current.length + sentence.length + 1 > limit) {
        chunks.push({ pageIndex: page.pageIndex, text: current });
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence.slice(0, limit);
    }
    if (current) chunks.push({ pageIndex: page.pageIndex, text: current });
  }
  return chunks;
}

function parseItems(structured: unknown, text: string): { category: string; quote: string }[] {
  let value = structured;
  if (value === undefined) {
    const from = text.indexOf('{');
    const to = text.lastIndexOf('}');
    try { value = from >= 0 && to > from ? JSON.parse(text.slice(from, to + 1)) : undefined; } catch { value = undefined; }
  }
  const items = (value as { items?: unknown })?.items;
  return Array.isArray(items)
    ? items.filter((i): i is { category: string; quote: string } =>
        typeof i?.category === 'string' && typeof i?.quote === 'string')
    : [];
}

export async function suggestRedactions(
  document: PdfDocument, provider: PdfAiProvider | undefined, contextTokens: number, options: PdfRedactionOptions = {},
): Promise<PdfRedactionReview> {
  const wanted = new Set<PdfRedactionCategory>(options.categories ?? [...PATTERN_CATEGORIES, ...MODEL_CATEGORIES]);
  const patternCategories = new Set(PATTERN_CATEGORIES.filter((c) => wanted.has(c)));
  const modelCategories = MODEL_CATEGORIES.filter((c) => wanted.has(c));
  const { pages, pagesWithoutText } = await readPages(document, options.pages);

  const found: Omit<PdfRedactionSuggestion, 'id' | 'rects' | 'text'>[] = [];
  for (const page of pages) {
    for (const m of findPatterns(page.text, patternCategories)) {
      found.push({ category: m.category, source: 'rules', pageIndex: page.pageIndex, start: m.start, end: m.end });
    }
  }

  let modelUsed = false;
  if (provider && modelCategories.length > 0) {
    const limit = Math.floor(contextTokens * 3 * 0.6);
    const result = await resolve<{ category: PdfModelRedactionCategory; quote: string }[]>({
      customProvider: async () => {
        const verified: { category: PdfModelRedactionCategory; quote: string }[] = [];
        for (const chunk of chunksOf(pages, limit)) {
          const response = await provider.generate({ prompt: redactionPrompt(chunk.text), schema: redactionSchema });
          for (const item of parseItems(response.structured, response.text)) {
            const category = item.category as PdfModelRedactionCategory;
            if (!modelCategories.includes(category) || item.quote.trim().length < 3) continue;
            if (locateQuote(chunk.text, item.quote)) verified.push({ category, quote: item.quote });
          }
        }
        return verified;
      },
    });
    if ('value' in result) {
      modelUsed = true;
      for (const { category, quote } of result.value) {
        for (const page of pages) {
          for (const at of occurrences(page.text, quote)) {
            found.push({ category, source: result.source, pageIndex: page.pageIndex, ...at });
          }
        }
      }
    }
  }

  // Patterns are deterministic, so a model suggestion that overlaps one is dropped.
  const kept = found.filter((s) => s.source === 'rules' || !found.some((p) =>
    p.source === 'rules' && p.pageIndex === s.pageIndex && s.start < p.end && p.start < s.end));
  const unique = new Map<string, (typeof kept)[number]>();
  for (const s of kept) unique.set(`${s.pageIndex}:${s.start}-${s.end}:${s.category}`, s);
  const ordered = [...unique.entries()].sort(([, a], [, b]) => a.pageIndex - b.pageIndex || a.start - b.start);

  const textOf = new Map(pages.map((p) => [p.pageIndex, p.text]));
  const suggestions: PdfRedactionSuggestion[] = [];
  for (const [id, s] of ordered) {
    suggestions.push({
      ...s, id, text: textOf.get(s.pageIndex)!.slice(s.start, s.end),
      rects: await rectsForRange(document, s.pageIndex, s.start, s.end),
    });
  }

  return {
    suggestions, modelUsed, pagesWithoutText, notice: REDACTION_NOTICE,
    apply: (acceptedIds) => applyRedactions(document, suggestions, textOf, acceptedIds),
  };
}

async function applyRedactions(
  document: PdfDocument, suggestions: readonly PdfRedactionSuggestion[],
  textBefore: ReadonlyMap<number, string>, acceptedIds: readonly string[],
): Promise<PdfRedactionApplied> {
  const known = new Set(suggestions.map((s) => s.id));
  for (const id of acceptedIds) if (!known.has(id)) throw new Error(`unknown suggestion: ${id}`);
  const accepted = suggestions.filter((s) => acceptedIds.includes(s.id));

  const snapshot = await document.snapshot();
  const report = await document.redact(accepted.flatMap((s) =>
    s.rects.map((rect) => ({ kind: 'region' as const, rect, pageIndex: s.pageIndex }))));

  // Offsets move once text is removed, so count occurrences instead: after the redaction a
  // page should hold each accepted text as many times as it was not accepted.
  const remaining: PdfRedactionSuggestion[] = [];
  for (const pageIndex of new Set(accepted.map((s) => s.pageIndex))) {
    const after = await (await document.page(pageIndex)).text.string();
    const before = textBefore.get(pageIndex)!;
    for (const text of new Set(accepted.filter((s) => s.pageIndex === pageIndex).map((s) => s.text))) {
      const removed = accepted.filter((s) => s.pageIndex === pageIndex && s.text === text).length;
      if (occurrences(after, text).length > occurrences(before, text).length - removed) {
        remaining.push(...accepted.filter((s) => s.pageIndex === pageIndex && s.text === text));
      }
    }
  }
  return { report, remaining, undo: () => snapshot.open() };
}
