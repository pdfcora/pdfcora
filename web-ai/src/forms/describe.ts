import type { PdfDocument, PdfFormField, PdfRect } from '@pdfiumkit/web';
import type { PdfPageRange } from '../text.js';

export interface PdfFieldDescription {
  readonly pageIndex: number;
  readonly annotationIndex: number;
  readonly name?: string;
  readonly alternateName?: string;
  /** Page text next to the field (FORM-1). */
  readonly label?: string;
  readonly field: PdfFormField;
}

const low = (r: PdfRect) => Math.min(r.bottom, r.top);
const high = (r: PdfRect) => Math.max(r.bottom, r.top);
const left = (r: PdfRect) => Math.min(r.left, r.right);
const right = (r: PdfRect) => Math.max(r.left, r.right);

/** Every form field on the pages in scope, with the label printed next to it. */
export async function describeFields(document: PdfDocument, range?: PdfPageRange): Promise<PdfFieldDescription[]> {
  const count = await document.pageCount();
  const described: PdfFieldDescription[] = [];
  for (let pageIndex = Math.max(0, range?.from ?? 0); pageIndex <= Math.min(count - 1, range?.to ?? count - 1); pageIndex++) {
    const page = await document.page(pageIndex);
    const fields = await page.formFields();
    if (fields.length === 0) continue;
    const text = await page.text.string();
    const boxes: (PdfRect | null)[] = [];
    for (let i = 0; i < text.length; i++) {
      const box = await page.text.boundingBox(i);
      boxes.push(box.right > box.left && box.top > box.bottom ? box : null);
    }
    for (const field of fields) {
      described.push({
        pageIndex, annotationIndex: field.annotationIndex, name: field.name, alternateName: field.alternateName,
        label: labelFor(field.rect, fields.map((f) => f.rect), text, boxes), field,
      });
    }
  }
  return described;
}

/** Spec §4: text on the field's line to its left, else just above it. */
export function labelFor(rect: PdfRect, others: readonly PdfRect[], text: string, boxes: readonly (PdfRect | null)[]): string | undefined {
  const bound = Math.max(left(rect) - 250, ...others
    .filter((o) => o !== rect && right(o) <= left(rect) && low(o) < high(rect) && low(rect) < high(o))
    .map(right));
  const onLine = (b: PdfRect) => {
    const centre = (b.top + b.bottom) / 2;
    return centre >= low(rect) - 2 && centre <= high(rect) + 2 && b.right <= left(rect) + 1 && b.left >= bound;
  };
  const above = (b: PdfRect) => b.bottom >= high(rect) && b.bottom - high(rect) <= 14 && b.right > left(rect) && b.left < right(rect);
  for (const accept of [onLine, above]) {
    const hits = boxes.flatMap((b, i) => (b && accept(b) ? [i] : []));
    if (hits.length === 0) continue;
    const label = text.slice(hits[0], hits[hits.length - 1]! + 1).trim().replace(/[:\s]+$/, '');
    if (label) return label;
  }
  return undefined;
}
