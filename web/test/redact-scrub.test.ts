import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));
const asText = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

/**
 * Page content is only half of redaction. A comment, a filled field or an attachment can
 * carry the removed text straight back out of the document.
 */
describe('scrubbing what is not page content', () => {
  test('an annotation over the region is removed', async () => {
    const document = await PdfDocument.open(read('annotation_highlight_long_content.pdf'));
    const page = await document.page(0);
    const annotations = await page.annotations();
    assert.ok(annotations.length > 0, 'the fixture must carry an annotation');

    const report = await document.redact([
      { kind: 'region', rect: annotations[0]!.rect, pageIndex: 0 },
    ]);
    assert.ok(report.annotations > 0, 'the report must say the annotation went');

    const after = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
      .annotations();
    assert.ok(after.length < annotations.length);
  });

  test('an annotation outside the region survives', async () => {
    const document = await PdfDocument.open(read('annotation_highlight_long_content.pdf'));
    const before = (await (await document.page(0)).annotations()).length;

    const report = await document.redact([
      { kind: 'region', rect: { left: -500, bottom: -500, right: -499, top: -499 }, pageIndex: 0 },
    ]);
    assert.equal(report.annotations, 0);

    const after = (await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
      .annotations()).length;
    assert.equal(after, before);
  });

  test('an attachment containing a redacted string is deleted', async () => {
    const document = await PdfDocument.open(read('embedded_attachments.pdf'));
    const before = (await document.attachments()).length;
    assert.ok(before > 0, 'the fixture must carry attachments');

    const names = (await document.attachments()).map((a) => a.name);
    const report = await document.redact([{ kind: 'textMatches', query: names[0]!.slice(0, 4) }]);

    assert.ok(report.attachments.length > 0, `nothing matched ${JSON.stringify(names)}`);
    const after = (await (await PdfDocument.open(await document.toBytes('full'))).attachments()).length;
    assert.ok(after < before);
  });

  test('attachments untouched by the query survive', async () => {
    const document = await PdfDocument.open(read('embedded_attachments.pdf'));
    const before = (await document.attachments()).length;

    const report = await document.redact([{ kind: 'textMatches', query: 'zzzznotpresent' }]);
    assert.equal(report.attachments.length, 0);

    const after = (await (await PdfDocument.open(await document.toBytes('full'))).attachments()).length;
    assert.equal(after, before);
  });

  /** A filled field carries its value outside the content stream. */
  test('a form field value in the region is removed with its widget', async () => {
    const document = await PdfDocument.open(read('text_form.pdf'));
    const page = await document.page(0);
    const field = (await page.formFields())[0]!;
    await page.setText('SECRETVALUE', field.annotationIndex);

    const report = await document.redact([{ kind: 'region', rect: field.rect, pageIndex: 0 }]);
    assert.ok(report.annotations > 0, 'the widget is an annotation and must go');

    const saved = await document.toBytes('full');
    assert.ok(!asText(saved).includes('SECRETVALUE'),
      'a filled field carries the text out of the document');
  });
});
