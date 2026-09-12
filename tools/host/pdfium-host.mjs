import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

// PDFium error codes from fpdfview.h
const ERR = { 0: 'success', 1: 'unknown', 2: 'file', 3: 'format', 4: 'password', 5: 'security', 6: 'page' };

export async function loadPdfium() {
  const factory = require(join(ROOT, 'vendor', 'web', 'pdfium.js'));
  const M = await factory();
  M.ccall('FPDF_InitLibrary', null, [], []);

  const lastError = () => M.ccall('FPDF_GetLastError', 'number', [], []);

  function openDocument(bytes, password = null) {
    const ptr = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    const handle = M.ccall(
      'FPDF_LoadMemDocument', 'number',
      ['number', 'number', 'string'], [ptr, bytes.length, password]
    );
    if (!handle) {
      const code = lastError();
      M._free(ptr);
      throw new Error(`load failed: ${ERR[code] ?? code}`);
    }
    // The buffer must outlive the document; PDFium reads from it lazily.
    return makeDoc(handle, ptr);
  }

  function makeDoc(handle, bufPtr) {
    let closed = false;
    const guard = () => { if (closed) throw new Error('document is closed'); };
    return {
      get pageCount() {
        guard();
        return M.ccall('FPDF_GetPageCount', 'number', ['number'], [handle]);
      },
      pageSize(i) {
        guard();
        const page = M.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [handle, i]);
        if (!page) throw new Error(`page ${i} failed to load`);
        const width = M.ccall('FPDF_GetPageWidthF', 'number', ['number'], [page]);
        const height = M.ccall('FPDF_GetPageHeightF', 'number', ['number'], [page]);
        M.ccall('FPDF_ClosePage', null, ['number'], [page]);
        return { width, height };
      },
      metadata(key) {
        guard();
        const len = M.ccall('FPDF_GetMetaText', 'number',
          ['number', 'string', 'number', 'number'], [handle, key, 0, 0]);
        if (len <= 2) return '';
        const out = M._malloc(len);
        M.ccall('FPDF_GetMetaText', 'number',
          ['number', 'string', 'number', 'number'], [handle, key, out, len]);
        const u16 = new Uint16Array(M.HEAPU8.buffer, out, (len / 2) - 1);
        const text = String.fromCharCode(...u16);
        M._free(out);
        return text;
      },
      close() {
        if (closed) return;
        M.ccall('FPDF_CloseDocument', null, ['number'], [handle]);
        M._free(bufPtr);
        closed = true;
      },
    };
  }

  return { openDocument, lastError };
}
