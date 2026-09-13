/**
 * Removing what is not page content.
 *
 * Page objects are only half of it. A comment, a filled field, a metadata entry or an
 * attachment can carry the removed text straight back out of the document, and a reader
 * that redacts only the page has not redacted the document.
 */

import type { PdfiumModule } from '../engine.js';
import type { PdfRect } from '../types.js';
import type { RedactionCounts } from './region.js';

const intersects = (a: PdfRect, b: PdfRect): boolean =>
  a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom;

/**
 * Removes annotations a region touches.
 *
 * Highest index first, because removing one shifts every index above it.
 */
export function scrubAnnotations(
  m: PdfiumModule,
  page: number,
  regions: readonly PdfRect[],
  counts: RedactionCounts,
): void {
  const count = m.ccall('FPDFPage_GetAnnotCount', 'number', ['number'], [page]) as number;
  if (count <= 0) return;

  const doomed: number[] = [];
  for (let index = 0; index < count; index++) {
    const annotation = m.ccall('FPDFPage_GetAnnot', 'number',
      ['number', 'number'], [page, index]) as number;
    if (!annotation) continue;

    try {
      const rect = annotationRect(m, annotation);
      if (!rect || !regions.some((r) => intersects(rect, r))) continue;

      // A form field's value lives in the AcroForm field dictionary, not on the page,
      // so removing the widget alone leaves the value in the file. Clearing /V first is
      // what actually takes the text out.
      clearFieldValue(m, annotation, counts);
      doomed.push(index);
    } finally {
      m.ccall('FPDFPage_CloseAnnot', null, ['number'], [annotation]);
    }
  }

  for (const index of doomed.reverse()) {
    if (m.ccall('FPDFPage_RemoveAnnot', 'number', ['number', 'number'], [page, index]) as number) {
      counts.annotations++;
    }
  }
}

/** Empties a widget's value, and records the field name in the report. */
function clearFieldValue(m: PdfiumModule, annotation: number, counts: RedactionCounts): void {
  const empty = m._malloc(2);
  try {
    new Uint16Array(m.HEAPU8.buffer, empty, 1)[0] = 0;
    const cleared = m.ccall('FPDFAnnot_SetStringValue', 'number',
      ['number', 'string', 'number'], [annotation, 'V', empty]) as number;
    if (!cleared) return;

    const name = stringValue(m, annotation, 'T');
    counts.formFields.push(name || '(unnamed)');
  } finally {
    m._free(empty);
  }
}

function stringValue(m: PdfiumModule, annotation: number, key: string): string {
  const size = m.ccall('FPDFAnnot_GetStringValue', 'number',
    ['number', 'string', 'number', 'number'], [annotation, key, 0, 0]) as number;
  if (size <= 2) return '';

  const ptr = m._malloc(size);
  try {
    m.ccall('FPDFAnnot_GetStringValue', 'number',
      ['number', 'string', 'number', 'number'], [annotation, key, ptr, size]);
    return String.fromCharCode(...new Uint16Array(m.HEAPU8.buffer, ptr, size / 2 - 1));
  } finally {
    m._free(ptr);
  }
}

function annotationRect(m: PdfiumModule, annotation: number): PdfRect | undefined {
  const ptr = m._malloc(16);
  try {
    const ok = m.ccall('FPDFAnnot_GetRect', 'number',
      ['number', 'number'], [annotation, ptr]) as number;
    if (!ok) return undefined;
    const values = new Float32Array(m.HEAPU8.buffer, ptr, 4);
    return {
      left: Math.min(values[0]!, values[2]!),
      bottom: Math.min(values[1]!, values[3]!),
      right: Math.max(values[0]!, values[2]!),
      top: Math.max(values[1]!, values[3]!),
    };
  } finally {
    m._free(ptr);
  }
}

/**
 * Attachments whose name or content carries a redacted string.
 *
 * Highest index first, for the same reason as annotations.
 */
export function scrubAttachments(
  m: PdfiumModule,
  document: number,
  needles: readonly string[],
  counts: RedactionCounts,
): void {
  if (needles.length === 0) return;

  const count = m.ccall('FPDFDoc_GetAttachmentCount', 'number', ['number'], [document]) as number;
  const doomed: { index: number; name: string }[] = [];

  for (let index = 0; index < count; index++) {
    const attachment = m.ccall('FPDFDoc_GetAttachment', 'number',
      ['number', 'number'], [document, index]) as number;
    if (!attachment) continue;

    const name = attachmentName(m, attachment);
    const content = attachmentContent(m, attachment);
    if (needles.some((n) => name.includes(n) || content.includes(n))) {
      doomed.push({ index, name });
    }
  }

  for (const { index, name } of doomed.reverse()) {
    if (m.ccall('FPDFDoc_DeleteAttachment', 'number',
      ['number', 'number'], [document, index]) as number) {
      counts.attachments.push(name);
    }
  }
}

function attachmentName(m: PdfiumModule, attachment: number): string {
  const size = m.ccall('FPDFAttachment_GetName', 'number',
    ['number', 'number', 'number'], [attachment, 0, 0]) as number;
  if (size <= 2) return '';

  const ptr = m._malloc(size);
  try {
    m.ccall('FPDFAttachment_GetName', 'number',
      ['number', 'number', 'number'], [attachment, ptr, size]);
    return String.fromCharCode(...new Uint16Array(m.HEAPU8.buffer, ptr, size / 2 - 1));
  } finally {
    m._free(ptr);
  }
}

/** Read as latin-1: the point is to find a string in it, not to interpret it. */
function attachmentContent(m: PdfiumModule, attachment: number): string {
  const sizePtr = m._malloc(4);
  try {
    m.ccall('FPDFAttachment_GetFile', 'number',
      ['number', 'number', 'number', 'number'], [attachment, 0, 0, sizePtr]);
    // `unsigned long` is 32-bit under wasm32; reading it wider picks up heap garbage.
    const size = new Uint32Array(m.HEAPU8.buffer, sizePtr, 1)[0]!;
    if (size === 0) return '';

    const ptr = m._malloc(size);
    try {
      m.ccall('FPDFAttachment_GetFile', 'number',
        ['number', 'number', 'number', 'number'], [attachment, ptr, size, sizePtr]);
      return new TextDecoder('latin1').decode(m.HEAPU8.subarray(ptr, ptr + size));
    } finally {
      m._free(ptr);
    }
  } finally {
    m._free(sizePtr);
  }
}
