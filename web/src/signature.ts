import { withBuffer, type PdfiumModule } from './engine.js';
import type { PdfSignature } from './types.js';

/**
 * Reads the signatures a document already carries.
 *
 * Reading only: PDFium exposes no way to create one, and no crypto at all. Nothing here
 * validates anything — `contents` is handed back as the raw PKCS#7 blob for a verifier
 * to check.
 */
export function readSignatures(m: PdfiumModule, doc: number, fileLength: number): PdfSignature[] {
  const count = m.ccall('FPDF_GetSignatureCount', 'number', ['number'], [doc]) as number;
  if (count <= 0) return [];

  const signatures: PdfSignature[] = [];
  for (let index = 0; index < count; index++) {
    const handle = m.ccall('FPDF_GetSignatureObject', 'number',
      ['number', 'number'], [doc, index]) as number;
    if (!handle) continue;

    const byteRange = readByteRange(m, handle);
    signatures.push({
      index,
      reason: readReason(m, handle) || undefined,
      signingTime: parsePdfDate(readAscii(m, handle, 'FPDFSignatureObj_GetTime')),
      subFilter: readAscii(m, handle, 'FPDFSignatureObj_GetSubFilter') || undefined,
      byteRange,
      contents: readContents(m, handle),
      docMdpPermission: readDocMdp(m, handle),
      coversWholeDocument: coversWholeDocument(byteRange, fileLength),
    });
  }
  return signatures;
}

/**
 * Whether the signed ranges reach the end of the file.
 *
 * Computed, not read. A signature whose byte range stops short does not protect what
 * follows, and treating "has a valid signature" as "is unmodified" is exactly how a
 * signed document gets silently amended.
 */
function coversWholeDocument(byteRange: number[], fileLength: number): boolean {
  if (byteRange.length < 2) return false;
  const start = byteRange[byteRange.length - 2]!;
  const length = byteRange[byteRange.length - 1]!;
  return start + length === fileLength;
}

/**
 * PDFium's two-call convention, with the byte range as pairs of ints.
 *
 * The out-parameter is `unsigned long`, which is 32-bit under wasm32.
 */
function readByteRange(m: PdfiumModule, signature: number): number[] {
  const count = m.ccall('FPDFSignatureObj_GetByteRange', 'number',
    ['number', 'number', 'number'], [signature, 0, 0]) as number;
  if (count <= 0) return [];

  return withBuffer(m, count * 4, (ptr) => {
    m.ccall('FPDFSignatureObj_GetByteRange', 'number',
      ['number', 'number', 'number'], [signature, ptr, count]);
    return Array.from(new Int32Array(m.HEAPU8.buffer, ptr, count));
  });
}

function readContents(m: PdfiumModule, signature: number): Uint8Array {
  const size = m.ccall('FPDFSignatureObj_GetContents', 'number',
    ['number', 'number', 'number'], [signature, 0, 0]) as number;
  if (size <= 0) return new Uint8Array(0);

  return withBuffer(m, size, (ptr) => {
    m.ccall('FPDFSignatureObj_GetContents', 'number',
      ['number', 'number', 'number'], [signature, ptr, size]);
    return m.HEAPU8.slice(ptr, ptr + size);
  });
}

/**
 * `/Reason` is UTF-16LE, unlike the sub-filter and time, which the header documents as
 * 7-bit ASCII. Reading it as bytes interleaves NULs into the result.
 */
function readReason(m: PdfiumModule, signature: number): string {
  const size = m.ccall('FPDFSignatureObj_GetReason', 'number',
    ['number', 'number', 'number'], [signature, 0, 0]) as number;
  if (size <= 2) return '';                      // a lone terminator means absent

  return withBuffer(m, size, (ptr) => {
    m.ccall('FPDFSignatureObj_GetReason', 'number',
      ['number', 'number', 'number'], [signature, ptr, size]);
    const units = new Uint16Array(m.HEAPU8.buffer, ptr, size / 2 - 1);
    return String.fromCharCode(...units);
  });
}

/** The sub-filter and time are 7-bit ASCII byte strings, not PDFium's usual UTF-16. */
function readAscii(m: PdfiumModule, signature: number, fn: string): string {
  const size = m.ccall(fn, 'number', ['number', 'number', 'number'], [signature, 0, 0]) as number;
  if (size <= 0) return '';

  return withBuffer(m, size, (ptr) => {
    m.ccall(fn, 'number', ['number', 'number', 'number'], [signature, ptr, size]);
    const bytes = m.HEAPU8.subarray(ptr, ptr + size);
    // PDFium counts the trailing NUL in the reported size for these fields.
    const end = bytes[size - 1] === 0 ? size - 1 : size;
    return String.fromCharCode(...bytes.subarray(0, end));
  });
}

function readDocMdp(m: PdfiumModule, signature: number): number | undefined {
  const value = m.ccall('FPDFSignatureObj_GetDocMDPPermission', 'number',
    ['number'], [signature]) as number;
  return value > 0 ? value : undefined;
}

/**
 * PDF dates look like `D:YYYYMMDDHHmmSSOHH'mm'`, where everything after the year is
 * optional and the offset may be `Z`, `+`, or `-`.
 */
const PDF_DATE = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z|\+|-)(\d{2})'?(\d{2})?)?/;

function parsePdfDate(value: string): Date | undefined {
  const match = PDF_DATE.exec(value.trim());
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  let stamp = Date.UTC(
    Number(year), Number(month ?? '1') - 1, Number(day ?? '1'),
    Number(hour ?? '0'), Number(minute ?? '0'), Number(second ?? '0'));

  if (sign === '+' || sign === '-') {
    const offset = (Number(offsetHours ?? '0') * 60 + Number(offsetMinutes ?? '0')) * 60_000;
    stamp += sign === '+' ? -offset : offset;
  }
  return Number.isNaN(stamp) ? undefined : new Date(stamp);
}
