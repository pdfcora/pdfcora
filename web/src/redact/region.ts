/**
 * Removing content from a page.
 *
 * The objects a region touches are removed and the content stream regenerated, so the
 * content leaves the file rather than being covered. Drawing a black rectangle over text
 * is the classic redaction failure: it looks right and the words are still there.
 *
 * The document must be saved with `'full'` afterwards. An incremental save keeps the
 * original content stream in the file, which defeats the entire exercise.
 */

import type { PdfiumModule } from './../engine.js';
import { readPageObjects } from '../pageObjects.js';
import type { PdfPageObject, PdfRect, PdfRedactionReport, PdfRedactionTarget } from '../types.js';

export interface RedactionCounts {
  textObjects: number;
  textObjectsSplit: number;
  images: number;
  paths: number;
  annotations: number;
  formFields: string[];
  metadataKeys: string[];
  attachments: string[];
  pages: number[];
}

export function emptyCounts(): RedactionCounts {
  return {
    textObjects: 0, textObjectsSplit: 0, images: 0, paths: 0, annotations: 0,
    formFields: [], metadataKeys: [], attachments: [], pages: [],
  };
}

export function toReport(counts: RedactionCounts): PdfRedactionReport {
  return { ...counts, pages: [...counts.pages].sort((a, b) => a - b) };
}

/** Whether two rectangles overlap at all. Touching edges count, deliberately. */
export function intersects(a: PdfRect, b: PdfRect): boolean {
  return a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom;
}

/** Regions to apply to one page. */
export function regionsFor(targets: readonly PdfRedactionTarget[], pageIndex: number): PdfRect[] {
  return targets
    .filter((t) => t.kind === 'region' && t.pageIndex === pageIndex)
    .map((t) => (t as { rect: PdfRect }).rect);
}

/**
 * Removes every object a region touches, and regenerates the content stream.
 *
 * Objects are removed highest index first: removing one shifts every index above it, and
 * walking upward would silently skip objects.
 */
export function redactPage(
  m: PdfiumModule,
  page: number,
  textPage: number,
  regions: readonly PdfRect[],
  counts: RedactionCounts,
): boolean {
  if (regions.length === 0) return false;

  const objects = readPageObjects(m, page, textPage);
  const doomed = objects.filter((object) => regions.some((r) => intersects(object.bounds, r)));
  if (doomed.length === 0) return false;

  for (const object of [...doomed].sort((a, b) => b.index - a.index)) {
    const handle = m.ccall('FPDFPage_GetObject', 'number',
      ['number', 'number'], [page, object.index]) as number;
    if (!handle) continue;

    const removed = m.ccall('FPDFPage_RemoveObject', 'number',
      ['number', 'number'], [page, handle]) as number;
    if (!removed) continue;

    // RemoveObject detaches but does not free; without this the object leaks for the
    // life of the document.
    m.ccall('FPDFPageObj_Destroy', null, ['number'], [handle]);
    count(counts, object);
  }

  const regenerated = m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]) as number;
  if (!regenerated) throw new Error('redact: the page content could not be regenerated');
  return true;
}

function count(counts: RedactionCounts, object: PdfPageObject): void {
  switch (object.kind) {
    case 'text': counts.textObjects++; break;
    case 'image': counts.images++; break;
    // Shadings and form XObjects are counted as paths rather than given their own
    // field: a caller wants to know something was removed, and the distinction between
    // a path and a shading does not change what they do about it.
    default: counts.paths++; break;
  }
}
