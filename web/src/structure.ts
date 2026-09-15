/**
 * A page's structure tree, as PDFium reads it, and re-marking content as an artifact.
 *
 * PDFium's structure-tree API is read-only; writing goes through writer/structure.ts.
 */

import { readUtf16, withBuffer, type PdfiumModule } from './engine.js';
import type { PdfRect, PdfStructureElement } from './types.js';

const MAX_DEPTH = 64;

export function readStructure(m: PdfiumModule, page: number): PdfStructureElement[] {
  const tree = m.ccall('FPDF_StructTree_GetForPage', 'number', ['number'], [page]) as number;
  if (!tree) return [];
  try {
    const bounds = boundsByMarkedContentId(m, page);
    const count = m.ccall('FPDF_StructTree_CountChildren', 'number', ['number'], [tree]) as number;
    const roots: PdfStructureElement[] = [];
    for (let i = 0; i < count; i++) {
      const element = m.ccall('FPDF_StructTree_GetChildAtIndex', 'number', ['number', 'number'], [tree, i]) as number;
      if (element) roots.push(readElement(m, element, bounds, 0));
    }
    return roots;
  } finally {
    m.ccall('FPDF_StructTree_Close', null, ['number'], [tree]);
  }
}

function readElement(
  m: PdfiumModule,
  element: number,
  bounds: ReadonlyMap<number, PdfRect>,
  depth: number,
): PdfStructureElement {
  const text = (fn: string) => readUtf16(m,
    () => m.ccall(fn, 'number', ['number', 'number', 'number'], [element, 0, 0]) as number,
    (ptr, size) => { m.ccall(fn, 'number', ['number', 'number', 'number'], [element, ptr, size]); }) || undefined;

  const markedContentIds: number[] = [];
  const idCount = m.ccall('FPDF_StructElement_GetMarkedContentIdCount', 'number', ['number'], [element]) as number;
  for (let i = 0; i < idCount; i++) {
    const id = m.ccall('FPDF_StructElement_GetMarkedContentIdAtIndex', 'number', ['number', 'number'], [element, i]) as number;
    if (id >= 0) markedContentIds.push(id);
  }

  const children: PdfStructureElement[] = [];
  if (depth < MAX_DEPTH) {
    const childCount = m.ccall('FPDF_StructElement_CountChildren', 'number', ['number'], [element]) as number;
    for (let i = 0; i < childCount; i++) {
      const child = m.ccall('FPDF_StructElement_GetChildAtIndex', 'number', ['number', 'number'], [element, i]) as number;
      if (child) children.push(readElement(m, child, bounds, depth + 1));
    }
  }

  const rect = [...markedContentIds.map((id) => bounds.get(id)), ...children.map((c) => c.bounds)]
    .filter((r): r is PdfRect => r !== undefined)
    .reduce<PdfRect | undefined>((all, r) => (all ? union(all, r) : r), undefined);

  return {
    type: text('FPDF_StructElement_GetType') ?? '',
    ...optional('altText', text('FPDF_StructElement_GetAltText')),
    ...optional('actualText', text('FPDF_StructElement_GetActualText')),
    ...optional('title', text('FPDF_StructElement_GetTitle')),
    ...optional('language', text('FPDF_StructElement_GetLang')),
    markedContentIds,
    ...(rect ? { bounds: rect } : {}),
    children,
  };
}

const optional = <K extends string>(key: K, value: string | undefined) =>
  (value ? { [key]: value } : {}) as Partial<Record<K, string>>;

function boundsByMarkedContentId(m: PdfiumModule, page: number): Map<number, PdfRect> {
  const result = new Map<number, PdfRect>();
  const count = m.ccall('FPDFPage_CountObjects', 'number', ['number'], [page]) as number;
  for (let i = 0; i < count; i++) {
    const object = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, i]) as number;
    const id = object ? m.ccall('FPDFPageObj_GetMarkedContentID', 'number', ['number'], [object]) as number : -1;
    if (id < 0) continue;
    const rect = objectBounds(m, object);
    const known = result.get(id);
    result.set(id, known ? union(known, rect) : rect);
  }
  return result;
}

function objectBounds(m: PdfiumModule, object: number): PdfRect {
  return withBuffer(m, 16, (ptr) => {
    m.ccall('FPDFPageObj_GetBounds', 'number', ['number', 'number', 'number', 'number', 'number'],
      [object, ptr, ptr + 4, ptr + 8, ptr + 12]);
    const [l, b, r, t] = new Float32Array(m.HEAPU8.buffer, ptr, 4);
    return { left: Math.min(l!, r!), bottom: Math.min(b!, t!), right: Math.max(l!, r!), top: Math.max(b!, t!) };
  });
}

const union = (a: PdfRect, b: PdfRect): PdfRect => ({
  left: Math.min(a.left, b.left), bottom: Math.min(a.bottom, b.bottom),
  right: Math.max(a.right, b.right), top: Math.max(a.top, b.top),
});

/**
 * Re-marks every top-level object whose marked content has one of `ids` as an artifact,
 * and regenerates the page's content. Returns how many objects changed.
 */
export function markArtifacts(m: PdfiumModule, page: number, ids: ReadonlySet<number>): number {
  let changed = 0;
  const count = m.ccall('FPDFPage_CountObjects', 'number', ['number'], [page]) as number;
  for (let i = 0; i < count; i++) {
    const object = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, i]) as number;
    if (!object) continue;
    const marks = m.ccall('FPDFPageObj_CountMarks', 'number', ['number'], [object]) as number;
    for (let k = marks - 1; k >= 0; k--) {
      const mark = m.ccall('FPDFPageObj_GetMark', 'number', ['number', 'number'], [object, k]) as number;
      const id = mark ? withBuffer(m, 4, (out) => {
        const ok = m.ccall('FPDFPageObjMark_GetParamIntValue', 'number',
          ['number', 'string', 'number'], [mark, 'MCID', out]) as number;
        return ok ? new Int32Array(m.HEAPU8.buffer, out, 1)[0]! : -1;
      }) : -1;
      if (!ids.has(id)) continue;
      m.ccall('FPDFPageObj_RemoveMark', 'number', ['number', 'number'], [object, mark]);
      m.ccall('FPDFPageObj_AddMark', 'number', ['number', 'string'], [object, 'Artifact']);
      changed++;
      break;
    }
  }
  if (changed > 0) m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
  return changed;
}

/**
 * Gives each listed object a content mark named `tag`, with an `MCID` parameter unless
 * `mcid` is negative, and regenerates the page's content.
 */
export function markTags(
  m: PdfiumModule,
  document: number,
  page: number,
  marks: readonly { readonly index: number; readonly tag: string; readonly mcid: number }[],
): void {
  for (const { index, tag, mcid } of marks) {
    const object = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, index]) as number;
    if (!object) continue;
    const mark = m.ccall('FPDFPageObj_AddMark', 'number', ['number', 'string'], [object, tag]) as number;
    if (mark && mcid >= 0) {
      m.ccall('FPDFPageObjMark_SetIntParam', 'number', ['number', 'number', 'number', 'string', 'number'],
        [document, object, mark, 'MCID', mcid]);
    }
  }
  m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
}
