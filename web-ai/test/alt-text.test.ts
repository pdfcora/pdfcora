import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, type PdfStructureElement } from '@pdfcora/web';
import { PdfAI, type PdfAiRequest } from '../dist/index.js';

const DIR = new URL('../../conformance/alt-text/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('tagged-expected.json', DIR), 'utf8'));
const tagged = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('tagged.pdf', DIR))));

const flatten = (elements: readonly PdfStructureElement[]): PdfStructureElement[] =>
  elements.flatMap((e) => [e, ...flatten(e.children)]);

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

describe('alt text proposals', () => {
  test('without a model, the figures missing alt text are listed and the rule is decorative', async () => {
    const review = await new PdfAI(await tagged()).altText.suggest();
    assert.equal(review.untagged, false);
    assert.equal(review.modelUsed, false);
    assert.match(review.notice, /Check every description before it is written\./);
    assert.deepEqual(review.items.map((i) => ({ pageIndex: i.pageIndex, markedContentIds: i.markedContentIds, kind: i.kind })),
      EXPECTED.figuresWithoutAlt.map((f: { pageIndex: number; markedContentIds: number[]; kind: string }) =>
        ({ pageIndex: f.pageIndex, markedContentIds: f.markedContentIds, kind: f.kind })));
    for (const [i, item] of review.items.entries()) {
      const expected = EXPECTED.figuresWithoutAlt[i];
      assert.equal(item.id, `${item.pageIndex}:${item.markedContentIds.join(',')}`);
      assert.equal(item.text, '');
      assert.equal(item.source, item.kind === 'decorative' ? 'rules' : null);
      if (expected.caption) assert.ok(item.context.includes(expected.caption), item.context);
    }
  });

  test('a provider receives one PNG per described figure and its descriptions are used', async () => {
    const requests: PdfAiRequest[] = [];
    const provider = {
      async generate(request: PdfAiRequest) {
        requests.push(request);
        const logo = request.prompt.includes('company logo');
        return { text: JSON.stringify({ decorative: false, description: logo ? 'Red circle logo' : 'Office building at dusk' }) };
      },
    };
    const review = await new PdfAI(await tagged(), { provider }).altText.suggest();
    assert.equal(requests.length, 2, 'the rule is decorative by rules and needs no call');
    for (const request of requests) {
      assert.equal(request.images?.length, 1);
      assert.deepEqual([...request.images![0]!.subarray(0, 8)], PNG);
    }
    assert.equal(review.modelUsed, true);
    assert.deepEqual(review.items.map((i) => [i.kind, i.text, i.source]), [
      ['description', 'Office building at dusk', 'customProvider'],
      ['decorative', '', 'rules'],
      ['description', 'Red circle logo', 'customProvider'],
    ]);
  });

  test('a provider answering decorative is honoured; one that throws leaves the text empty', async () => {
    let calls = 0;
    const provider = {
      async generate() {
        if (calls++ === 0) return { text: '', structured: { decorative: true, description: '' } };
        throw new Error('offline');
      },
    };
    const review = await new PdfAI(await tagged(), { provider }).altText.suggest();
    assert.deepEqual(review.items.map((i) => [i.kind, i.source]), [['decorative', 'customProvider'], ['decorative', 'rules'], ['description', null]]);
  });

  test('apply writes edited and proposed decisions into a new document', async () => {
    const document = await tagged();
    const provider = { async generate() { return { text: '', structured: { decorative: false, description: 'Office building' } }; } };
    const review = await new PdfAI(document, { provider }).altText.suggest();
    const [photo, rule, logo] = review.items;

    const updated = await review.apply([{ id: photo!.id }, { id: rule!.id }, { id: logo!.id, text: 'Company logo' }]);
    const figures = [0, 1].map(async (p) => flatten(await (await updated.page(p)).structure()).filter((e) => e.type === 'Figure'));
    assert.deepEqual((await figures[0]!).map((f) => f.altText), [EXPECTED.figuresWithAlt[0].altText, 'Office building']);
    assert.deepEqual((await figures[1]!).map((f) => f.altText), ['Company logo']);
    assert.equal((await new PdfAI(updated).altText.suggest()).items.length, 0);
  });

  test('apply refuses an unknown id or a missing description, writing nothing', async () => {
    const review = await new PdfAI(await tagged()).altText.suggest();
    await assert.rejects(review.apply([{ id: '9:9' }]), /unknown/);
    await assert.rejects(review.apply([{ id: review.items[0]!.id }]), /no description/);
  });

  test('an untagged document reports untagged and lists nothing', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../conformance/corpus/hello_world.pdf', import.meta.url)));
    const review = await new PdfAI(await PdfDocument.open(bytes)).altText.suggest();
    assert.equal(review.untagged, true);
    assert.deepEqual(review.items, []);
  });
});
