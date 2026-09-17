import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfcora/web';
import { PdfAI, type PdfAiRequest } from '../dist/index.js';
import { similarity } from '../dist/diff/compare.js';

const DIR = new URL('../../conformance/diff/', import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
const open = (name: string) => PdfDocument.open(new Uint8Array(readFileSync(new URL(name, DIR))));

describe('semantic diff', () => {
  test('similarity cases', () => {
    for (const c of json('similarity.json')) {
      const value = similarity(c.a, c.b);
      if (c.atLeast !== undefined) assert.ok(value >= c.atLeast, `${c.a} / ${c.b}: ${value}`);
      if (c.below !== undefined) assert.ok(value < c.below, `${c.a} / ${c.b}: ${value}`);
      if (c.exactly !== undefined) assert.equal(value, c.exactly, `${c.a} / ${c.b}`);
    }
  });

  test('without a model, sentences align exactly as expected, with rectangles', async () => {
    const diff = await new PdfAI(await open('original.pdf')).diff.compare(await open('revised.pdf'));
    assert.equal(diff.modelUsed, false);
    assert.match(diff.notice, /Check the differences against both documents\./);
    assert.deepEqual(diff.changes.map((c) => ({
      kind: c.kind, ...(c.original ? { original: c.original.text } : {}), ...(c.revised ? { revised: c.revised.text } : {}),
    })), json('expected.json'));
    assert.deepEqual(diff.changes.map((c) => c.label), ['unclassified', 'meaningChanged', 'unclassified', 'meaningChanged']);
    assert.deepEqual(diff.changes.map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
    for (const c of diff.changes) {
      for (const s of [c.original, c.revised]) if (s) assert.equal(s.rects.length, 1, s.text);
    }
    assert.equal(diff.changes[2]!.original!.pageIndex, 1);
  });

  test('a provider labels reworded pairs; bad or failed answers stay unclassified', async () => {
    const requests: PdfAiRequest[] = [];
    const provider = {
      async generate(request: PdfAiRequest) {
        requests.push(request);
        if (request.prompt.includes('30 days')) {
          return { text: '', structured: { label: 'meaningChanged', summary: 'The notice period doubles to 60 days.' } };
        }
        return { text: '{"label": "wordingOnly", "summary": ""}' };
      },
    };
    const diff = await new PdfAI(await open('original.pdf'), { provider }).diff.compare(await open('revised.pdf'));
    assert.equal(requests.length, 2, 'added and removed sentences need no model');
    assert.equal(diff.modelUsed, true);
    assert.deepEqual(diff.changes.map((c) => [c.label, c.summary, c.source]), [
      ['wordingOnly', undefined, 'customProvider'],
      ['meaningChanged', undefined, 'rules'],
      ['meaningChanged', 'The notice period doubles to 60 days.', 'customProvider'],
      ['meaningChanged', undefined, 'rules'],
    ]);

    let calls = 0;
    const flaky = { async generate() { if (calls++ === 0) return { text: '{"label":"maybe"}' }; throw new Error('offline'); } };
    const unsure = await new PdfAI(await open('original.pdf'), { provider: flaky }).diff.compare(await open('revised.pdf'));
    assert.equal(unsure.modelUsed, false);
    assert.deepEqual(unsure.changes.filter((c) => c.kind === 'modified').map((c) => c.label), ['unclassified', 'unclassified']);
  });
});
