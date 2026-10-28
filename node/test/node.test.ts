import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFile, saveFile, renderPng, renderRaw, encodePng, PdfDocument, PdfError } from '../src/index.js';

// Compiled to dist-test/test/, so the repository root is three levels up.
const ROOT = new URL('../../../conformance/', import.meta.url).pathname;
const FIXTURES = ROOT + 'fixtures/';
const CORPUS = ROOT + 'corpus/';
const contract = () => openFile(join(FIXTURES, 'contract.pdf'));

describe('@pdfcora/node', () => {
  test('opens a PDF from a path', async () => {
    const document = await contract();
    assert.equal(await document.pageCount(), 3);
    const text = await (await document.page(0)).text.string();
    assert.match(text, /Parties/);
    await document.close();
  });

  test('a missing file fails as a filesystem error, not a PDF one', async () => {
    await assert.rejects(() => openFile(join(FIXTURES, 'nope.pdf')), (e: NodeJS.ErrnoException) => e.code === 'ENOENT');
  });

  test('a password-protected file raises the SDK error every platform raises', async () => {
    await assert.rejects(
      () => openFile(join(CORPUS, 'encrypted_hello_world_r2.pdf')),
      (e: unknown) => e instanceof PdfError && e.code === 'passwordRequired');
  });

  test('renders a page as a PNG with the right header and size', async () => {
    const document = await contract();
    const page = await document.page(0);
    const png = await renderPng(page, { width: 400 });

    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
    const view = new DataView(png.buffer, png.byteOffset);
    assert.equal(view.getUint32(16), 400, 'width in IHDR');
    const raw = await renderRaw(page, { width: 400 });
    assert.equal(view.getUint32(20), raw.height, 'height in IHDR');
    // Lossless: a PNG of the same pixels must be byte-identical.
    assert.deepEqual([...png], [...encodePng(raw)]);
    await document.close();
  });

  test('saves to a path and the file reopens', async () => {
    const document = await contract();
    const out = join(mkdtempSync(join(tmpdir(), 'pdfcora-node-')), 'saved.pdf');
    const bytes = await saveFile(document, out);

    assert.equal(bytes, statSync(out).size);
    const reopened = await PdfDocument.open(new Uint8Array(readFileSync(out)));
    assert.equal(await reopened.pageCount(), 3);
    await reopened.close();
    await document.close();
  });

  test('the whole web API is re-exported, so code moves between the two unchanged', async () => {
    const web = await import('@pdfcora/web');
    const node = await import('../src/index.js');
    for (const name of Object.keys(web)) assert.ok(name in node, `${name} is missing from @pdfcora/node`);
  });
});
