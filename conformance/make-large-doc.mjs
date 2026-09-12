/**
 * Builds large PDFs for scale testing by repeatedly importing pages from a small one.
 *
 * The conformance corpus is deliberately tiny and synthetic. Nothing there says how the
 * SDK behaves on a document with hundreds of pages, so we assemble one.
 *
 * Usage: node conformance/make-large-doc.mjs [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdfium } from '../tools/host/pdfium-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(HERE, 'large');
mkdirSync(outDir, { recursive: true });

const { raw } = await loadPdfium();
const M = raw;

/** Imports `source` into `dest` `times` over, producing a multi-page document. */
function buildLarge(sourceBytes, times, label) {
  const srcPtr = M._malloc(sourceBytes.length);
  M.HEAPU8.set(sourceBytes, srcPtr);
  const source = M.ccall('FPDF_LoadMemDocument', 'number',
    ['number', 'number', 'string'], [srcPtr, sourceBytes.length, null]);
  if (!source) throw new Error('source document failed to load');

  const dest = M.ccall('FPDF_CreateNewDocument', 'number', [], []);
  // index is a 0-based insert position in dest, so it must track the running count.
  let inserted = 0;
  for (let i = 0; i < times; i++) {
    const ok = M.ccall('FPDF_ImportPages', 'number',
      ['number', 'number', 'string', 'number'], [dest, source, null, inserted]);
    if (!ok) throw new Error(`import ${i} failed at index ${inserted}`);
    inserted = M.ccall('FPDF_GetPageCount', 'number', ['number'], [dest]);
  }

  const pageCount = M.ccall('FPDF_GetPageCount', 'number', ['number'], [dest]);

  const chunks = [];
  const cb = M.addFunction((_fw, data, size) => {
    chunks.push(Buffer.from(M.HEAPU8.subarray(data, data + size)));
    return 1;
  }, 'iiii');
  const writer = M._malloc(8);
  new Int32Array(M.HEAPU8.buffer, writer, 2).set([1, cb]);
  const saved = M.ccall('FPDF_SaveAsCopy', 'number', ['number', 'number', 'number'], [dest, writer, 2]);
  M.removeFunction(cb);
  M._free(writer);
  if (!saved) throw new Error('save failed');

  const out = Buffer.concat(chunks);
  const path = join(outDir, `${label}.pdf`);
  writeFileSync(path, out);
  console.log(`  ${label.padEnd(22)} ${String(pageCount).padStart(4)} pages  ${(out.length / 1048576).toFixed(1)} MB`);

  M.ccall('FPDF_CloseDocument', null, ['number'], [dest]);
  M.ccall('FPDF_CloseDocument', null, ['number'], [source]);
  M._free(srcPtr);
  return path;
}

const corpus = (name) => new Uint8Array(readFileSync(join(HERE, 'corpus', name)));

console.log('building large documents:');
buildLarge(corpus('many_rectangles.pdf'), 300, 'vector-300');
buildLarge(corpus('annotation_stamp_with_ap.pdf'), 200, 'annotated-200');
buildLarge(corpus('text_font.pdf'), 400, 'text-400');
console.log(`\nwritten to ${outDir}`);
