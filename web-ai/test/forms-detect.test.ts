import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfiumkit/web';
import { PdfiumAI } from '../dist/index.js';

const DIR = new URL('../../conformance/forms/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('flat-expected.json', DIR), 'utf8'));
const flat = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('flat.pdf', DIR))));
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

describe('flat form detection', () => {
  test('the rules find exactly the expected blanks, with labels', async () => {
    const detected = await new PdfiumAI(await flat()).forms.detect();
    assert.match(detected.notice, /Check every field before it is added\./);
    assert.deepEqual(detected.items.map((i) => [i.pageIndex, i.kind, i.label]), EXPECTED.map((e: { pageIndex: number; kind: string; label: string }) => [e.pageIndex, e.kind, e.label]));
    detected.items.forEach((item, n) => {
      const e = EXPECTED[n].rect;
      assert.ok(near(item.rect.left, e.left) && near(item.rect.bottom, e.bottom) && near(item.rect.right, e.right) && near(item.rect.top, e.top),
        `${item.label}: ${JSON.stringify(item.rect)}`);
      assert.equal(item.id, `0:${n}`);
    });
  });

  test('accepted fields are created, and smart form filling then proposes values for them', async () => {
    const document = await flat();
    const detected = await new PdfiumAI(document).forms.detect();
    const withFields = await detected.apply(detected.items.map((i) => i.id));
    const fields = await (await withFields.page(0)).formFields();
    assert.deepEqual(fields.map((f) => [f.kind, f.name, f.alternateName]), detected.items.map((i) => [i.kind, i.label, i.label]));

    const proposals = await new PdfiumAI(withFields).forms.propose({ givenName: 'Anna', familyName: 'Schmidt', email: 'anna@example.com', city: 'London' });
    assert.deepEqual(proposals.items.map((p) => [p.fieldName, p.value]), [
      ['First name', 'Anna'], ['Last name', 'Schmidt'], ['Email', 'anna@example.com'], ['City', 'London'],
    ]);
    assert.equal((await (await document.page(0)).formFields()).length, 0);
    await assert.rejects(detected.apply(['9:9']), /unknown/);
  });

  test('a form that already has fields proposes nothing over them', async () => {
    const detected = await new PdfiumAI(await flat()).forms.detect();
    const withFields = await detected.apply(detected.items.map((i) => i.id));
    assert.deepEqual((await new PdfiumAI(withFields).forms.detect()).items, []);
  });
});
