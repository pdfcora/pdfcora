import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfiumkit/web';
import { PdfiumAI, type PdfAiRequest } from '../dist/index.js';

const ROOT = new URL('../../conformance/redaction/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('pii-expected.json', ROOT), 'utf8'));
const pii = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('pii.pdf', ROOT))));
const model = (items: (prompt: string) => { category: string; quote: string }[]) => ({
  requests: [] as PdfAiRequest[],
  async generate(request: PdfAiRequest) {
    this.requests.push(request);
    return { text: '', structured: { items: items(request.prompt) } };
  },
});

describe('redaction suggestions', () => {
  test('without a model, the patterns alone find exactly the expected items', async () => {
    const review = await new PdfiumAI(await pii()).redactions.suggest();
    assert.equal(review.modelUsed, false);
    assert.match(review.notice, /Suggestions may be incomplete\. Review the whole document\./);
    assert.deepEqual(review.suggestions.map((s) => ({ pageIndex: s.pageIndex, category: s.category, text: s.text })), EXPECTED);
    for (const s of review.suggestions) {
      assert.equal(s.source, 'rules');
      assert.equal(s.id, `${s.pageIndex}:${s.start}-${s.end}:${s.category}`);
      assert.ok(s.rects.length > 0, `${s.text} has no rectangles`);
    }
  });

  test('a model quote is verified, expanded to every occurrence, and never overlaps a pattern', async () => {
    const provider = model(() => [
      { category: 'personName', quote: 'Anna Schmidt' },
      { category: 'personName', quote: 'Nobody Invented' },
      { category: 'dateOfBirth', quote: '14 March 1985' },
      { category: 'idNumber', quote: 'Li' },
      { category: 'bankBalance', quote: 'Customer record' },
    ]);
    const review = await new PdfiumAI(await pii(), { provider }).redactions.suggest({ pages: { from: 0, to: 0 } });
    assert.equal(review.modelUsed, true);
    const fromModel = review.suggestions.filter((s) => s.source === 'customProvider');
    assert.deepEqual(fromModel.map((s) => [s.category, s.text]), [['personName', 'Anna Schmidt'], ['personName', 'Anna Schmidt']]);
    assert.ok(provider.requests[0]!.schema, 'the model is given a schema');
  });

  test('a failing model leaves the pattern suggestions', async () => {
    const provider = { generate: async () => { throw new Error('offline'); } };
    const review = await new PdfiumAI(await pii(), { provider }).redactions.suggest();
    assert.equal(review.modelUsed, false);
    assert.equal(review.suggestions.length, EXPECTED.length);
  });

  test('categories restrict both patterns and the model', async () => {
    const review = await new PdfiumAI(await pii()).redactions.suggest({ categories: ['iban'] });
    assert.deepEqual(review.suggestions.map((s) => s.text), ['GB29 NWBK 6016 1331 9268 19', 'DE89 3704 0044 0532 0130 00']);
  });

  test('apply removes accepted text, keeps rejected text, and undo restores it', async () => {
    const document = await pii();
    const review = await new PdfiumAI(document).redactions.suggest({ pages: { from: 0, to: 0 } });
    const email = review.suggestions.find((s) => s.category === 'email')!;
    const iban = review.suggestions.find((s) => s.category === 'iban')!;

    const applied = await review.apply([email.id]);
    assert.deepEqual(applied.remaining, []);
    const saved = await PdfDocument.open(await document.toBytes('full'));
    const text = await (await saved.page(0)).text.string();
    assert.ok(!text.includes(email.text), 'accepted text is gone');
    assert.ok(text.includes(iban.text), 'rejected text stays');
    assert.ok(text.includes('Email'), 'the word before the email stays');

    const restored = await applied.undo();
    assert.ok((await (await restored.page(0)).text.string()).includes(email.text));
  });

  test('an unknown id writes nothing', async () => {
    const document = await pii();
    const review = await new PdfiumAI(document).redactions.suggest();
    await assert.rejects(review.apply([review.suggestions[0]!.id, 'nope']), /unknown suggestion: nope/);
    assert.ok((await (await document.page(0)).text.string()).includes(review.suggestions[0]!.text));
  });
});
