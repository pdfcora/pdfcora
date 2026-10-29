import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, PdfError } from '../dist/index.js';

const read = (path: string) => new Uint8Array(readFileSync(new URL(`../../conformance/${path}`, import.meta.url)));
const text = (path: string) => readFileSync(new URL(`../../conformance/${path}`, import.meta.url), 'utf8');
const invalid = (e: unknown) => e instanceof PdfError && e.code === 'invalidOperation';
const blank = () => PdfDocument.open(read('xfdf/source-blank.pdf'));

test('imports the conformance file with the expected report', async () => {
  const report = await (await blank()).importXfdf(text('xfdf/import.xfdf'));
  assert.deepEqual(report, JSON.parse(text('xfdf/expected-import.json')).report);
});

test('exports what was imported', async () => {
  const document = await blank();
  await document.importXfdf(text('xfdf/import.xfdf'));
  assert.equal(await document.exportXfdf(), text('xfdf/expected-after-import.xfdf'));
});

test('rejectsDoctype', async () => {
  const document = await blank();
  const before = await document.exportXfdf();
  await assert.rejects(document.importXfdf(text('xfdf/doctype.xfdf')), invalid);
  assert.equal(await document.exportXfdf(), before);
});

test('rejects malformed XML without writing', async () => {
  const document = await blank();
  const before = await document.exportXfdf();
  await assert.rejects(document.importXfdf(text('xfdf/malformed.xfdf')), invalid);
  await assert.rejects(document.importXfdf('<notxfdf/>'), invalid);
  assert.equal(await document.exportXfdf(), before);
});

test('rejects input over 10 MiB', async () => {
  await assert.rejects((await blank()).importXfdf('a'.repeat(10485761)), invalid);
});

test('importingTwiceAddsTwice', async () => {
  const document = await blank();
  const xfdf = text('xfdf/import.xfdf');
  assert.equal((await document.importXfdf(xfdf)).annotationsAdded, 5);
  assert.equal((await document.importXfdf(xfdf)).annotationsAdded, 5);
  const page0 = await document.page(0);
  assert.equal((await page0.annotations()).filter((a) => a.kind === 'ink').length, 2);
});

test('a saved and reopened document keeps imported author and dates', async () => {
  const document = await blank();
  await document.importXfdf(text('xfdf/import.xfdf'));
  const reopened = await PdfDocument.open(await document.toBytes('full'));
  const xfdf = await reopened.exportXfdf();
  assert.ok(xfdf.includes('title="Imported &amp; signed"'));
  assert.ok(xfdf.includes('date="D:20261030100000Z"'));
  assert.ok(xfdf.includes('name="imp-ink"'));
});

test('edge cases round-trip: >> and << in text, CR, LF, tab, emoji, 72.03125', async () => {
  const document = await blank();
  const report = await document.importXfdf(text('xfdf/edge.xfdf'));
  assert.equal(report.annotationsAdded, 2);
  const exported = await document.exportXfdf();
  assert.equal(exported, text('xfdf/expected-edge-export.xfdf'));
  const again = await blank();
  await again.importXfdf(exported);
  assert.equal(await again.exportXfdf(), exported, 'export → import → export is stable');
});

test('rejects XFDF nested deeper than the limit', async () => {
  const deep = '<xfdf><fields>' + '<field name="a">'.repeat(300) + '</field>'.repeat(300) + '</fields></xfdf>';
  await assert.rejects((await blank()).importXfdf(deep), invalid);
});
