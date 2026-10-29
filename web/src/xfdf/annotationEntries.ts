import { readUtf16, withBuffer, withUtf16, type PdfiumModule } from '../engine.js';
import type { PdfDocument } from '../document.js';
import type { PdfPoint } from '../types.js';

/** What XFDF carries about an annotation that the public `PdfAnnotation` does not. */
export interface AnnotationEntries {
  readonly name?: string;
  readonly title?: string;
  readonly modified?: string;
  readonly created?: string;
  readonly opacity?: number;
  readonly borderWidth?: number;
  readonly line?: readonly [PdfPoint, PdfPoint];
  readonly defaultAppearance?: string;
  readonly icon?: string;
}

function readString(m: PdfiumModule, annot: number, key: string): string | undefined {
  const text = readUtf16(
    m,
    () => m.ccall('FPDFAnnot_GetStringValue', 'number', ['number', 'string', 'number', 'number'], [annot, key, 0, 0]) as number,
    (ptr, size) => m.ccall('FPDFAnnot_GetStringValue', 'number', ['number', 'string', 'number', 'number'], [annot, key, ptr, size]),
  );
  return text || undefined;
}

function readNumber(m: PdfiumModule, annot: number, key: string): number | undefined {
  return withBuffer(m, 4, (ptr) =>
    m.ccall('FPDFAnnot_GetNumberValue', 'number', ['number', 'string', 'number'], [annot, key, ptr])
      ? new Float32Array(m.HEAPU8.buffer, ptr, 1)[0]
      : undefined);
}

/** Reads the entries of annotation `index` on page `pageIndex`. */
export function readAnnotationEntries(document: PdfDocument, pageIndex: number, index: number): Promise<AnnotationEntries> {
  return document.withPage(pageIndex, (page, m) => {
    const annot = m.ccall('FPDFPage_GetAnnot', 'number', ['number', 'number'], [page, index]) as number;
    if (!annot) return {};
    try {
      const borderWidth = withBuffer(m, 12, (ptr) =>
        m.ccall('FPDFAnnot_GetBorder', 'number', ['number', 'number', 'number', 'number'], [annot, ptr, ptr + 4, ptr + 8])
          ? new Float32Array(m.HEAPU8.buffer, ptr, 3)[2]
          : undefined);
      const line = withBuffer(m, 16, (ptr) => {
        if (!m.ccall('FPDFAnnot_GetLine', 'number', ['number', 'number', 'number'], [annot, ptr, ptr + 8])) return undefined;
        const v = new Float32Array(m.HEAPU8.buffer, ptr, 4);
        return [{ x: v[0]!, y: v[1]! }, { x: v[2]!, y: v[3]! }] as const;
      });
      return {
        name: readString(m, annot, 'NM'),
        title: readString(m, annot, 'T'),
        modified: readString(m, annot, 'M'),
        created: readString(m, annot, 'CreationDate'),
        opacity: readNumber(m, annot, 'CA'),
        borderWidth,
        line,
        defaultAppearance: readString(m, annot, 'DA'),
        icon: readString(m, annot, 'Name'),
      };
    } finally {
      m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
    }
  });
}

/** Writes the string entries XFDF carries onto annotation `index`. Absent values are left alone. */
export function writeAnnotationStrings(
  document: PdfDocument, pageIndex: number, index: number,
  values: Readonly<Record<'NM' | 'T' | 'M' | 'CreationDate' | 'Contents', string | undefined>>,
): Promise<boolean> {
  return document.withPage(pageIndex, (page, m) => {
    const annot = m.ccall('FPDFPage_GetAnnot', 'number', ['number', 'number'], [page, index]) as number;
    if (!annot) return false;
    try {
      let ok = true;
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) continue;
        ok = withUtf16(m, value, (ptr) =>
          (m.ccall('FPDFAnnot_SetStringValue', 'number', ['number', 'string', 'number'], [annot, key, ptr]) as number) !== 0) && ok;
      }
      return ok;
    } finally {
      m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annot]);
    }
  });
}
