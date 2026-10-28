import type { PdfDocument, PdfRect } from '@pdfcora/web';
import { labelFor } from './describe.js';
import type { PdfPageRange } from '../text.js';

export const DETECT_NOTICE = 'Check every field before it is added.';

export interface PdfDetectedField {
  /** `"<pageIndex>:<n>"`, n counting on the page in order. */
  readonly id: string;
  readonly pageIndex: number;
  readonly kind: 'text' | 'checkBox';
  readonly rect: PdfRect;
  /** Empty when no label was found. */
  readonly label: string;
}

export interface PdfDetectedFields {
  readonly items: readonly PdfDetectedField[];
  /** Must be shown with the proposals (HIL). */
  readonly notice: string;
  /** Creates the accepted fields, returning a new document; this document is unchanged. */
  apply(acceptedIds: readonly string[]): Promise<PdfDocument>;
}

const FIELD_HEIGHT = 14;
type Rule = 'underscores' | 'line' | 'box' | 'square';
interface Candidate { readonly rule: Rule; readonly kind: 'text' | 'checkBox'; readonly rect: PdfRect }

const intersects = (a: PdfRect, b: PdfRect) =>
  a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;

/** Spec §3 rules 1–7 for one page: candidates in rule order, filtered. */
export function candidatesOf(
  objects: readonly { kind: string; bounds: PdfRect }[],
  text: string,
  boxes: readonly (PdfRect | null)[],
  widgets: readonly PdfRect[],
): Candidate[] {
  const found: Candidate[] = [];
  for (const run of text.matchAll(/_{5,}/g)) {
    const rects = boxes.slice(run.index!, run.index! + run[0].length).filter((b): b is PdfRect => b !== null);
    if (rects.length === 0) continue;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.min(...rects.map((r) => r.bottom));
    found.push({ rule: 'underscores', kind: 'text', rect: { left, bottom, right, top: bottom + FIELD_HEIGHT } });
  }
  const paths = objects.filter((o) => o.kind === 'path').map((o) => o.bounds);
  for (const b of paths) {
    if (b.right - b.left >= 40 && b.top - b.bottom <= 2) {
      found.push({ rule: 'line', kind: 'text', rect: { left: b.left, bottom: b.bottom, right: b.right, top: b.bottom + FIELD_HEIGHT } });
    }
  }
  for (const b of paths) {
    const h = b.top - b.bottom;
    if (b.right - b.left >= 40 && h >= 10 && h <= 40) found.push({ rule: 'box', kind: 'text', rect: b });
  }
  for (const b of paths) {
    const w = b.right - b.left;
    const h = b.top - b.bottom;
    if (w >= 6 && w <= 16 && h >= 6 && h <= 16 && Math.abs(w - h) <= 2) found.push({ rule: 'square', kind: 'checkBox', rect: b });
  }

  const occupied = (r: PdfRect) => boxes.some((b, i) => {
    if (!b || /[\s_]/.test(text[i]!)) return false;
    const x = (b.left + b.right) / 2;
    const y = (b.bottom + b.top) / 2;
    return x > r.left && x < r.right && y > r.bottom && y < r.top;
  });

  const kept: Candidate[] = [];
  for (const candidate of found) {
    if (occupied(candidate.rect) || widgets.some((w) => intersects(w, candidate.rect))) continue;
    const clash = kept.findIndex((k) => intersects(k.rect, candidate.rect));
    if (clash < 0) {
      kept.push(candidate);
    } else if ((candidate.rule === 'box' || candidate.rule === 'square')
      && (kept[clash]!.rule === 'underscores' || kept[clash]!.rule === 'line')) {
      kept[clash] = candidate;
    }
  }
  return kept;
}

/** Spec §3 rule 8 for a checkbox: text on the same line to its right first. */
function rightLabel(rect: PdfRect, others: readonly PdfRect[], text: string, boxes: readonly (PdfRect | null)[]): string | undefined {
  const bound = Math.min(rect.right + 250, ...others
    .filter((o) => o !== rect && o.left >= rect.right && o.bottom < rect.top && rect.bottom < o.top)
    .map((o) => o.left));
  const hits = boxes.flatMap((b, i) => {
    if (!b) return [];
    const centre = (b.top + b.bottom) / 2;
    return centre >= rect.bottom - 2 && centre <= rect.top + 2 && b.left >= rect.right - 1 && b.right <= bound ? [i] : [];
  });
  if (hits.length === 0) return undefined;
  const label = text.slice(hits[0], hits[hits.length - 1]! + 1).trim().replace(/[:\s]+$/, '');
  return label || undefined;
}

export async function detectFields(document: PdfDocument, range?: PdfPageRange): Promise<PdfDetectedFields> {
  const items: PdfDetectedField[] = [];
  const count = await document.pageCount();
  for (let pageIndex = Math.max(0, range?.from ?? 0); pageIndex <= Math.min(count - 1, range?.to ?? count - 1); pageIndex++) {
    const page = await document.page(pageIndex);
    const text = await page.text.string();
    const boxes: (PdfRect | null)[] = [];
    for (let i = 0; i < text.length; i++) {
      const b = await page.text.boundingBox(i);
      boxes.push(b.right > b.left && b.top > b.bottom ? b : null);
    }
    const widgets = (await page.formFields()).map((f) => f.rect);
    const candidates = candidatesOf(await page.objects(), text, boxes, widgets)
      .sort((a, b) => b.rect.top - a.rect.top || a.rect.left - b.rect.left);
    const rects = candidates.map((c) => c.rect);
    candidates.forEach((c, n) => {
      const label = (c.kind === 'checkBox' ? rightLabel(c.rect, rects, text, boxes) : undefined)
        ?? labelFor(c.rect, rects, text, boxes) ?? '';
      items.push({ id: `${pageIndex}:${n}`, pageIndex, kind: c.kind, rect: c.rect, label: label.replace(/\s+/g, ' ') });
    });
  }

  return {
    items,
    notice: DETECT_NOTICE,
    apply: async (acceptedIds) => {
      const known = new Set(items.map((i) => i.id));
      const unknown = acceptedIds.find((id) => !known.has(id));
      if (unknown !== undefined) throw new Error(`unknown detected field: ${unknown}`);
      const existing = new Set<string>();
      for (let p = 0; p < count; p++) for (const f of await (await document.page(p)).formFields()) if (f.name) existing.add(f.name);
      const fields = items.filter((i) => acceptedIds.includes(i.id)).map((item, n) => {
        const base = item.label || `Field ${n + 1}`;
        let name = base;
        for (let suffix = 2; existing.has(name); suffix++) name = `${base} ${suffix}`;
        existing.add(name);
        return { pageIndex: item.pageIndex, kind: item.kind, rect: item.rect, name, ...(item.label ? { tooltip: item.label } : {}) };
      });
      return document.addFormFields(fields);
    },
  };
}
