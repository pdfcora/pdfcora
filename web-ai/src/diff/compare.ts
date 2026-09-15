import type { PdfDocument, PdfRect } from '@pdfiumkit/web';
import { resolve, type PdfAiProvider, type PdfAiSource } from '../provider.js';
import { readPages, rectsForRange, sentencesOf, type PdfPageRange } from '../text.js';
import { trialText } from '../trial.js';

export const DIFF_NOTICE = 'Check the differences against both documents.';

export interface PdfDiffSide {
  readonly pageIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly rects: readonly PdfRect[];
}

export interface PdfDiffChange {
  /** `"c<n>"`, in order. */
  readonly id: string;
  readonly kind: 'modified' | 'added' | 'removed';
  readonly label: 'meaningChanged' | 'wordingOnly' | 'unclassified';
  readonly summary?: string;
  /** Absent for added sentences. */
  readonly original?: PdfDiffSide;
  /** Absent for removed sentences. */
  readonly revised?: PdfDiffSide;
  readonly source: PdfAiSource;
}

export interface PdfDiff {
  readonly changes: readonly PdfDiffChange[];
  readonly modelUsed: boolean;
  /** Must be shown with the changes. */
  readonly notice: string;
}

export interface PdfDiffOptions {
  readonly pages?: PdfPageRange;
  readonly revisedPages?: PdfPageRange;
}

interface Sentence { readonly pageIndex: number; readonly start: number; readonly end: number; readonly text: string; readonly key: string }

export type Alignment =
  | { readonly kind: 'modified'; readonly original: number; readonly revised: number }
  | { readonly kind: 'removed'; readonly original: number }
  | { readonly kind: 'added'; readonly revised: number };

const THRESHOLD = 0.3;

/** Spec §3.2. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ').trim();
}

/** Spec §3.5: Dice coefficient of character trigram sets. */
export function similarity(a: string, b: string): number {
  const grams = (text: string) => {
    const set = new Set<string>();
    const chars = [...normalise(text)];
    for (let i = 0; i + 3 <= chars.length; i++) set.add(chars.slice(i, i + 3).join(''));
    return set;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size + y.size === 0) return 0;
  let shared = 0;
  for (const g of x) if (y.has(g)) shared++;
  return (2 * shared) / (x.size + y.size);
}

/** Spec §3.3–3.6 over two lists of sentence texts. */
export function align(original: readonly string[], revised: readonly string[]): Alignment[] {
  const a = original.map(normalise);
  const b = revised.map(normalise);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const anchors: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { anchors.push([i, j]); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  anchors.push([a.length, b.length]);

  const result: Alignment[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj] of anchors) {
    const gapA: number[] = [];
    const gapB: number[] = [];
    for (; i < ai; i++) gapA.push(i);
    for (; j < bj; j++) gapB.push(j);
    let x = 0;
    let y = 0;
    const text = (list: readonly string[], gap: number[], k: number) => (k < gap.length ? list[gap[k]!]! : '');
    while (x < gapA.length && y < gapB.length) {
      if (similarity(text(original, gapA, x), text(revised, gapB, y)) >= THRESHOLD) {
        result.push({ kind: 'modified', original: gapA[x++]!, revised: gapB[y++]! });
      } else if (similarity(text(revised, gapB, y), text(original, gapA, x + 1))
        >= similarity(text(original, gapA, x), text(revised, gapB, y + 1))) {
        result.push({ kind: 'removed', original: gapA[x++]! });
      } else {
        result.push({ kind: 'added', revised: gapB[y++]! });
      }
    }
    for (; x < gapA.length; x++) result.push({ kind: 'removed', original: gapA[x]! });
    for (; y < gapB.length; y++) result.push({ kind: 'added', revised: gapB[y]! });
    i = ai + 1;
    j = bj + 1;
  }
  return result;
}

export const diffSchema = {
  type: 'object',
  properties: { label: { type: 'string', enum: ['meaningChanged', 'wordingOnly'] }, summary: { type: 'string' } },
  required: ['label', 'summary'],
};

export function diffPrompt(original: string, revised: string): string {
  return [
    'Two versions of a sentence from a document follow.',
    'Decide whether the revision changes the meaning — what is required, allowed or promised, or any number, date, name or amount — or only the wording.',
    'Reply with JSON: {"label": "meaningChanged" or "wordingOnly", "summary": "..."}.',
    'For meaningChanged, the summary is one sentence describing the change in meaning, in the language of the sentences; for wordingOnly it is empty.',
    `Original: ${JSON.stringify(original)}`,
    `Revised: ${JSON.stringify(revised)}`,
  ].join('\n');
}

export function parseLabel(structured: unknown, text: string): { label: 'meaningChanged' | 'wordingOnly'; summary: string } | null {
  let value = structured;
  if (value === undefined) {
    const from = text.indexOf('{');
    const to = text.lastIndexOf('}');
    try { value = JSON.parse(text.slice(from, to + 1)); } catch { return null; }
  }
  const { label, summary } = (value ?? {}) as { label?: unknown; summary?: unknown };
  if (label !== 'meaningChanged' && label !== 'wordingOnly') return null;
  return { label, summary: typeof summary === 'string' ? summary.trim() : '' };
}

async function sentences(document: PdfDocument, range?: PdfPageRange): Promise<Sentence[]> {
  const { pages } = await readPages(document, range);
  return pages.flatMap((page) => sentencesOf(page.text).map(({ start, end }) => {
    const text = page.text.slice(start, end);
    return { pageIndex: page.pageIndex, start, end, text, key: normalise(text) };
  }));
}

export async function compareDocuments(
  document: PdfDocument,
  revised: PdfDocument,
  provider: PdfAiProvider | undefined,
  options: PdfDiffOptions = {},
): Promise<PdfDiff> {
  const before = await sentences(document, options.pages);
  const after = await sentences(revised, options.revisedPages);
  const side = async (doc: PdfDocument, s: Sentence): Promise<PdfDiffSide> => ({
    pageIndex: s.pageIndex, start: s.start, end: s.end, text: s.text,
    rects: await rectsForRange(doc, s.pageIndex, s.start, s.end),
  });

  let modelUsed = false;
  const changes: PdfDiffChange[] = [];
  for (const item of align(before.map((s) => s.text), after.map((s) => s.text))) {
    const id = `c${changes.length + 1}`;
    if (item.kind === 'removed') {
      changes.push({ id, kind: 'removed', label: 'meaningChanged', original: await side(document, before[item.original]!), source: 'rules' });
      continue;
    }
    if (item.kind === 'added') {
      changes.push({ id, kind: 'added', label: 'meaningChanged', revised: await side(revised, after[item.revised]!), source: 'rules' });
      continue;
    }
    const original = await side(document, before[item.original]!);
    const changed = await side(revised, after[item.revised]!);
    const answer = provider
      ? await resolve({
          customProvider: async () => {
            const response = await provider.generate({ prompt: diffPrompt(original.text, changed.text), schema: diffSchema });
            return parseLabel(response.structured, response.text);
          },
        })
      : undefined;
    if (answer && 'value' in answer) {
      modelUsed = true;
      const summary = answer.value.label === 'meaningChanged' && answer.value.summary ? { summary: trialText(answer.value.summary) } : {};
      changes.push({ id, kind: 'modified', label: answer.value.label, ...summary, original, revised: changed, source: answer.source });
    } else {
      changes.push({ id, kind: 'modified', label: 'unclassified', original, revised: changed, source: 'rules' });
    }
  }
  return { changes, modelUsed, notice: trialText(DIFF_NOTICE) };
}
