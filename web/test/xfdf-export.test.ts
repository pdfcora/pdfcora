import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, PdfError } from '../dist/index.js';

const read = (path: string) => new Uint8Array(readFileSync(new URL(`../../conformance/${path}`, import.meta.url)));
const text = (path: string) => readFileSync(new URL(`../../conformance/${path}`, import.meta.url), 'utf8');
const invalid = (e: unknown) => e instanceof PdfError && e.code === 'invalidOperation';

test('exports the conformance document exactly', async () => {
  const document = await PdfDocument.open(read('xfdf/source.pdf'));
  assert.equal(await document.exportXfdf(), text('xfdf/expected-export.xfdf'));
});

test('exportEscapesAndKeepsUnicode', async () => {
  const xfdf = await (await PdfDocument.open(read('xfdf/source.pdf'))).exportXfdf();
  assert.ok(xfdf.includes('<value>Zoë &amp; "Co" &lt;ok&gt;</value>'));
  assert.ok(xfdf.includes('title="Zoë &amp; &quot;Co&quot; &lt;ok&gt;"'));
  assert.ok(xfdf.includes('<contents>A note &amp; a &lt;tag&gt;</contents>'));
});

test('exportsEmptyDocument', async () => {
  const xfdf = await (await PdfDocument.open(read('corpus/hello_world.pdf'))).exportXfdf();
  assert.equal(xfdf, '<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n</xfdf>\n');
});

test('export of a closed document fails', async () => {
  const document = await PdfDocument.open(read('xfdf/source.pdf'));
  await document.close();
  await assert.rejects(document.exportXfdf(), (e) => e instanceof PdfError);
});
