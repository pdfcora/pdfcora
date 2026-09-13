import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';
import type { PdfRedactionReport } from '../dist/index.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));

const asText = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/** Redacts the object whose text contains `needle`, and returns the saved bytes. */
async function redactContaining(file: string, needle: string) {
  const document = await PdfDocument.open(read(file));
  const page = await document.page(0);
  const target = (await page.objects()).find((o) => o.text?.includes(needle));
  assert.ok(target, `no object containing ${needle}`);

  const report = await document.redact([
    { kind: 'region', rect: target!.bounds, pageIndex: 0 },
  ]);
  return { report, saved: await document.toBytes('full') };
}

describe('redacting a region', () => {
  /**
   * The only assertion that matters. Checking extraction alone is not enough: a black
   * box drawn over text leaves the text in the file, which is the classic redaction
   * failure and the reason this feature exists.
   */
  test('redacted text is gone from the extracted text AND the file bytes', async () => {
    const { saved } = await redactContaining('hello_world.pdf', 'Goodbye');

    const reopened = await PdfDocument.open(saved);
    const text = await (await reopened.page(0)).text.string();
    assert.ok(!text.includes('Goodbye'), `still extractable: ${JSON.stringify(text)}`);
    assert.ok(!asText(saved).includes('Goodbye'), 'the text is still in the file bytes');

    // And what was not redacted must survive.
    assert.ok(text.includes('Hello'), `lost unrelated content: ${JSON.stringify(text)}`);
  });

  test('the report says what was removed', async () => {
    const { report } = await redactContaining('hello_world.pdf', 'Goodbye');
    assert.equal(report.textObjects, 1);
    assert.deepEqual([...report.pages], [0]);
  });

  test('an object outside the region is untouched', async () => {
    const document = await PdfDocument.open(read('hello_world.pdf'));
    // A region in an empty corner of the page.
    const report = await document.redact([
      { kind: 'region', rect: { left: 0, bottom: 0, right: 5, top: 5 }, pageIndex: 0 },
    ]);
    assert.equal(report.textObjects, 0);

    const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
      .text.string();
    assert.ok(text.includes('Hello') && text.includes('Goodbye'));
  });

  test('paths in the region are removed too', async () => {
    const document = await PdfDocument.open(read('rectangles.pdf'));
    const before = (await (await document.page(0)).objects()).length;
    assert.equal(before, 8);

    // A region covering the whole page.
    const report = await document.redact([
      { kind: 'region', rect: { left: -100, bottom: -100, right: 1000, top: 1000 }, pageIndex: 0 },
    ]);
    assert.equal(report.paths, 8);

    const after = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
      .objects();
    assert.equal(after.length, 0, 'everything in the region should be gone');
  });

  test('redacting nothing leaves the document readable and unchanged', async () => {
    const base = read('hello_world.pdf');
    const before = await (await (await PdfDocument.open(base)).page(0)).text.string();

    const document = await PdfDocument.open(base);
    await document.redact([]);
    const after = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
      .text.string();

    assert.equal(after, before);
  });

  /**
   * GenerateContent rewrites the whole content stream, so anything PDFium does not model
   * as a page object is lost in the rewrite. This is the control for that: open, redact
   * nothing, save, and the text must be identical.
   */
  test('a no-op redaction across the corpus preserves every page of text', async () => {
    const files = ['hello_world.pdf', 'text_form.pdf', 'rectangles.pdf', 'text_font.pdf',
                   'hebrew_mirrored.pdf', 'tagged_actual_text.pdf',
                   'annotation_highlight_long_content.pdf', 'find_text_consecutive.pdf'];

    for (const file of files) {
      const base = read(file);
      const before = await (await (await PdfDocument.open(base)).page(0)).text.string();

      const document = await PdfDocument.open(base);
      await document.redact([
        { kind: 'region', rect: { left: -9999, bottom: -9999, right: -9998, top: -9998 }, pageIndex: 0 },
      ]);
      const after = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
        .text.string();

      assert.equal(after, before, `${file}: the content stream rewrite lost text`);
    }
  });

  /**
   * Redaction requires a full save, and this pins why rather than leaving it a comment.
   * PDFium's incremental save does not write the regenerated content stream at all, so
   * the removed text survives in both the text layer and the bytes. Anyone tempted to
   * "optimise" redaction to an incremental save gets a failing test explaining it.
   */
  test('an incremental save does not erase anything', async () => {
    const document = await PdfDocument.open(read('hello_world.pdf'));
    const target = (await (await document.page(0)).objects())
      .find((o) => o.text?.includes('Goodbye'))!;
    await document.redact([{ kind: 'region', rect: target.bounds, pageIndex: 0 }]);

    const saved = await document.toBytes('incremental');
    const text = await (await (await PdfDocument.open(saved)).page(0)).text.string();

    assert.ok(text.includes('Goodbye'), 'incremental keeps the original content stream');
    assert.ok(asText(saved).includes('Goodbye'));
  });

  test('a region on a page that does not exist is refused', async () => {
    const document = await PdfDocument.open(read('hello_world.pdf'));
    await assert.rejects(
      () => document.redact([{ kind: 'region', rect: { left: 0, bottom: 0, right: 1, top: 1 }, pageIndex: 9 }]),
      /page/i);
  });
});

export type { PdfRedactionReport };
