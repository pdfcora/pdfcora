import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PdfDocument } from '../dist/index.js';
import { scanTrailer, nextObjectNumber } from '../dist/writer/scan.js';
import { appendUpdate } from '../dist/writer/incremental.js';
import { name, ref } from '../dist/writer/values.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(join(CORPUS, file)));
const documents = readdirSync(CORPUS)
  .filter((f) => f.endsWith('.pdf') && !f.startsWith('encrypted_'));

describe('incremental updates', () => {
  test('the original bytes survive untouched and the file only grows', () => {
    const base = read('hello_world.pdf');
    const out = appendUpdate(base, new Map([[nextObjectNumber(scanTrailer(base)), { Type: name('Unused') }]]));
    assert.ok(out.length > base.length);
    assert.deepEqual(out.subarray(0, base.length), base);
  });

  test('the update carries /Prev so the original xref stays reachable', () => {
    const base = read('hello_world.pdf');
    const tail = new TextDecoder('latin1').decode(appendUpdate(base, new Map()).subarray(base.length));
    assert.match(tail, /\/Prev\s+\d+/);
    assert.match(tail, /startxref\s+\d+\s*%%EOF\s*$/);
  });

  /** The acceptance criterion for the whole task: PDFium must still open the result. */
  test('every corpus document still opens, and its content is unchanged', async () => {
    for (const file of documents) {
      const base = read(file);
      const before = await PdfDocument.open(base);
      const pages = await before.pageCount();
      const text = await (await before.page(0)).text.string();

      const info = scanTrailer(base);
      const out = appendUpdate(base, new Map([[nextObjectNumber(info), { Type: name('Unused') }]]));

      const after = await PdfDocument.open(out);
      assert.equal(await after.pageCount(), pages, `${file}: page count changed`);
      assert.equal(await (await after.page(0)).text.string(), text, `${file}: text changed`);
    }
  });

  test('an appended update can replace an existing object', async () => {
    // Replacing /Info is the shape metadata scrubbing needs.
    const base = read('hello_world.pdf');
    const info = scanTrailer(base);
    const n = nextObjectNumber(info);
    const out = appendUpdate(base, new Map([[n, { Title: 'Replaced by PdfWriter' }]]),
                             { trailer: { Info: ref(n) } });
    const doc = await PdfDocument.open(out);
    assert.equal(await doc.metadataValue('Title'), 'Replaced by PdfWriter');
  });

  test('stacked updates each keep the one before reachable', async () => {
    let bytes: Uint8Array = read('hello_world.pdf');
    for (let i = 0; i < 3; i++) {
      bytes = appendUpdate(bytes, new Map([[nextObjectNumber(scanTrailer(bytes)), { Round: i }]]));
    }
    const original = await (await (await PdfDocument.open(read('hello_world.pdf'))).page(0)).text.string();
    const doc = await PdfDocument.open(bytes);
    assert.equal(await doc.pageCount(), 1);
    assert.equal(await (await doc.page(0)).text.string(), original);
  });
});
