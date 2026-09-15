import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, type PdfStructureElement } from '@pdfiumkit/web';
import { PdfiumAI } from '../dist/index.js';

const DIR = new URL('../../conformance/remediation/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('untagged-expected.json', DIR), 'utf8'));
const untagged = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('untagged.pdf', DIR))));

const types = (elements: readonly PdfStructureElement[]): string[] =>
  elements.flatMap((e) => [e.type, ...types(e.children)]);

describe('remediation proposals', () => {
  test('the rules propose exactly the expected blocks, types and order', async () => {
    const review = await new PdfiumAI(await untagged()).remediation.suggest();
    assert.equal(review.alreadyTagged, false);
    assert.match(review.notice, /Check every tag and the reading order before they are written\./);
    assert.deepEqual(review.blocks.map((b) => ({ pageIndex: b.pageIndex, type: b.type, objectCount: b.objectIndices.length, text: b.text })), EXPECTED);
    assert.deepEqual(review.blocks.map((b) => b.order), EXPECTED.map((_: unknown, i: number) => i + 1));
    for (const block of review.blocks) assert.equal(block.id, `${block.pageIndex}:${block.objectIndices[0]}`);
  });

  test('apply tags the document with overrides, titled by the first H1', async () => {
    const document = await untagged();
    const review = await new PdfiumAI(document).remediation.suggest();
    const caption = review.blocks.find((b) => b.text.startsWith('Figure 1'))!;
    const tagged = await review.apply({ language: 'en-GB', types: { [caption.id]: 'H3' } });

    assert.equal(await tagged.isTagged(), true);
    assert.equal((await tagged.metadata()).title, undefined, 'the title goes to XMP, not /Info');
    const page0 = types(await (await tagged.page(0)).structure());
    assert.deepEqual(page0, ['Document', 'H1', 'P', 'H2', 'L', 'LI', 'LBody', 'LI', 'LBody', 'LI', 'LBody', 'P', 'Figure', 'H3']);
    assert.equal(await document.isTagged(), false);
  });

  test('an unknown override id throws; a tagged document is not proposed for', async () => {
    const review = await new PdfiumAI(await untagged()).remediation.suggest();
    await assert.rejects(review.apply({ language: 'en', types: { '9:9': 'P' } }), /unknown/);

    const tagged = await review.apply({ language: 'en' });
    const again = await new PdfiumAI(tagged).remediation.suggest();
    assert.equal(again.alreadyTagged, true);
    assert.deepEqual(again.blocks, []);
  });
});
