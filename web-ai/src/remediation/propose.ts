import type { PdfDocument, PdfPageObject, PdfRect, PdfTagBlock, PdfTagType } from '@pdfcora/web';
import { looksDecorative } from '../alt-text/suggest.js';
import type { PdfPageRange } from '../text.js';

export const REMEDIATION_NOTICE = 'Check every tag and the reading order before they are written.';

export interface PdfRemediationBlock {
  /** `"<pageIndex>:<first object index>"`. */
  readonly id: string;
  /** 1-based, across the document. */
  readonly order: number;
  readonly pageIndex: number;
  readonly type: PdfTagType;
  readonly objectIndices: readonly number[];
  readonly rect: PdfRect;
  /** For review; empty for figures and artifacts. */
  readonly text: string;
}

export interface PdfRemediationOptions {
  /** Overrides a block's proposed type, by block id. */
  readonly types?: Readonly<Record<string, PdfTagType>>;
  /** BCP 47; needed when the document has no /Lang. */
  readonly language?: string;
  /** Defaults to the first H1's text, else the first heading's. */
  readonly title?: string;
}

export interface PdfRemediationReview {
  /** True when the document is tagged already: nothing is proposed. */
  readonly alreadyTagged: boolean;
  readonly blocks: readonly PdfRemediationBlock[];
  /** Must be shown with the proposals (HIL). */
  readonly notice: string;
  /** Tags the document as proposed, with any overrides, returning a new document. */
  apply(options?: PdfRemediationOptions): Promise<PdfDocument>;
}

const LIST_MARKER = /^(?:[•◦▪‣\-–*]\s|(?:\d{1,3}|[A-Za-z])[.)]\s)/;
const HEADING_RATIO = 1.2;
const HEADING_CHARS = 200;

interface Line { objects: PdfPageObject[]; rect: PdfRect; size: number; text: string }
interface Draft { pageIndex: number; type: PdfTagType; objects: PdfPageObject[]; rect: PdfRect; size: number; text: string }

const union = (a: PdfRect, b: PdfRect): PdfRect => ({
  left: Math.min(a.left, b.left), bottom: Math.min(a.bottom, b.bottom),
  right: Math.max(a.right, b.right), top: Math.max(a.top, b.top),
});
const isText = (o: PdfPageObject) => o.kind === 'text' && (o.text ?? '').trim().length > 0;
const sizeOf = (o: PdfPageObject) => o.fontSize ?? 0;

/** Spec §4.2 rules 2–3 and 6: one page's objects as blocks, before typing text blocks. */
export function pageBlocks(pageIndex: number, objects: readonly PdfPageObject[]): Draft[] {
  const blocks: Draft[] = [];
  let line: Line | undefined;
  let block: Draft | undefined;

  const closeLine = () => {
    if (!line) return;
    const current = line;
    line = undefined;
    const joins = block && blocks[blocks.length - 1] === block
      && Math.abs(block.size - current.size) <= 0.5
      && block.rect.bottom - current.rect.top <= current.size / 2
      && Math.abs(block.rect.left - current.rect.left) <= current.size
      && !LIST_MARKER.test(current.text);
    if (joins && block) {
      block.objects.push(...current.objects);
      block.rect = union(block.rect, current.rect);
      block.text = `${block.text} ${current.text}`;
    } else {
      block = { pageIndex, type: 'P', objects: [...current.objects], rect: current.rect, size: current.size, text: current.text };
      blocks.push(block);
    }
  };

  for (const object of objects) {
    if (object.kind === 'text' && !isText(object)) continue;
    if (!isText(object)) {
      closeLine();
      block = undefined;
      const figure = (object.kind === 'image' || object.kind === 'form') && !looksDecorative(object.bounds);
      blocks.push({ pageIndex, type: figure ? 'Figure' : 'Artifact', objects: [object], rect: object.bounds, size: 0, text: '' });
      continue;
    }
    const text = object.text!.trim();
    const b = object.bounds;
    const overlap = line ? Math.min(line.rect.top, b.top) - Math.max(line.rect.bottom, b.bottom) : 0;
    const sameLine = line
      && Math.abs(line.size - sizeOf(object)) <= 0.5
      && overlap >= Math.min(line.rect.top - line.rect.bottom, b.top - b.bottom) / 2
      && b.left >= line.rect.right - sizeOf(object);
    if (sameLine && line) {
      line.objects.push(object);
      line.rect = union(line.rect, b);
      line.text = `${line.text} ${text}`;
    } else {
      closeLine();
      line = { objects: [object], rect: b, size: sizeOf(object), text };
    }
  }
  closeLine();
  return blocks;
}

/** Spec §4.2 rules 1, 4 and 5 over every page's blocks. */
export function typeBlocks(drafts: Draft[]): void {
  const characters = new Map<number, number>();
  for (const d of drafts) {
    if (d.type === 'P') {
      for (const o of d.objects) {
        const size = Math.round(sizeOf(o) * 2) / 2;
        characters.set(size, (characters.get(size) ?? 0) + (o.text ?? '').length);
      }
    }
  }
  const body = [...characters].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0;
  const isHeading = (d: Draft) => body > 0 && d.size >= body * HEADING_RATIO && d.text.length <= HEADING_CHARS;

  const headingSizes = [...new Set(drafts.filter((d) => d.type === 'P' && !LIST_MARKER.test(d.text) && isHeading(d))
    .map((d) => Math.round(d.size * 2) / 2))].sort((a, b) => b - a);
  for (const d of drafts) {
    if (d.type !== 'P') continue;
    if (LIST_MARKER.test(d.text)) d.type = 'LI';
    else if (isHeading(d)) d.type = `H${Math.min(6, headingSizes.indexOf(Math.round(d.size * 2) / 2) + 1)}` as PdfTagType;
  }

  // PDF/UA 7.4.2: the first heading must be H1 and no level may be skipped. Sizes alone
  // break that whenever the largest text is not the first heading — a page number set
  // large, a table's total — which real documents do often.
  let previous = 0;
  for (const d of drafts) {
    const match = /^H([1-6])$/.exec(d.type);
    if (!match) continue;
    previous = Math.min(Number(match[1]), previous + 1);
    d.type = `H${previous}` as PdfTagType;
  }
}

export async function proposeRemediation(
  document: PdfDocument,
  options: { pages?: PdfPageRange } = {},
): Promise<PdfRemediationReview> {
  const alreadyTagged = await document.isTagged();
  const drafts: Draft[] = [];
  const count = await document.pageCount();
  const from = Math.max(0, options.pages?.from ?? 0);
  const to = Math.min(count - 1, options.pages?.to ?? count - 1);
  for (let pageIndex = from; !alreadyTagged && pageIndex <= to; pageIndex++) {
    drafts.push(...pageBlocks(pageIndex, await (await document.page(pageIndex)).objects()));
  }
  typeBlocks(drafts);

  const blocks: PdfRemediationBlock[] = drafts.map((d, i) => ({
    id: `${d.pageIndex}:${d.objects[0]!.index}`,
    order: i + 1,
    pageIndex: d.pageIndex,
    type: d.type,
    objectIndices: d.objects.map((o) => o.index),
    rect: d.rect,
    text: d.text,
  }));

  return {
    alreadyTagged,
    blocks,
    notice: REMEDIATION_NOTICE,
    apply: async (applyOptions = {}) => {
      const known = new Set(blocks.map((b) => b.id));
      for (const id of Object.keys(applyOptions.types ?? {})) {
        if (!known.has(id)) throw new Error(`unknown remediation block: ${id}`);
      }
      const typed = blocks.map((b) => ({ ...b, type: applyOptions.types?.[b.id] ?? b.type }));
      const headings = typed.filter((b) => /^H[1-6]$/.test(b.type));
      const title = applyOptions.title ?? (headings.find((b) => b.type === 'H1') ?? headings[0])?.text;
      return document.tagContent(
        typed.map((b) => ({ pageIndex: b.pageIndex, type: b.type, objectIndices: b.objectIndices })),
        { ...(title ? { title } : {}), ...(applyOptions.language ? { language: applyOptions.language } : {}) },
      );
    },
  };
}
