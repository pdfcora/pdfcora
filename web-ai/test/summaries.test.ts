import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '@pdfiumkit/web';
import { PdfiumAI } from '../dist/index.js';
import { summariseWithin } from '../dist/summaries.js';

const FIXTURES = new URL('../../conformance/fixtures/', import.meta.url).pathname;
const contract = () => PdfDocument.open(new Uint8Array(readFileSync(`${FIXTURES}contract.pdf`)));

/** Stands in for Chrome's Summarizer global, which Node does not have. */
function installChrome(state: 'available' | 'downloadable' | 'unavailable', options: {
  inputQuota?: number; languages?: string[]; inputs?: string[];
} = {}) {
  (globalThis as { Summarizer?: unknown }).Summarizer = {
    availability: async (o?: { expectedInputLanguages?: string[] }) => {
      const language = o?.expectedInputLanguages?.[0];
      if (language && options.languages && !options.languages.includes(language)) return 'unavailable';
      return state;
    },
    create: async (o?: { monitor?: (m: EventTarget) => void }) => {
      const monitor = new EventTarget();
      o?.monitor?.(monitor);
      monitor.dispatchEvent(Object.assign(new Event('downloadprogress'), { loaded: 0.5 }));
      return {
        inputQuota: options.inputQuota ?? 10_000,
        summarize: async (text: string) => {
          options.inputs?.push(text);
          return `summary(${text.length})`;
        },
        destroy() {},
      };
    },
  };
}

describe('summaries', () => {
  afterEach(() => { delete (globalThis as { Summarizer?: unknown }).Summarizer; });

  test('long text is split so no call exceeds the limit, then combined (SUM-2)', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => `Page ${i}. ` + 'Clause text goes here. '.repeat(40));
    const inputs: string[] = [];
    const limit = 2_000;
    const result = await summariseWithin(pages, limit, async (text) => {
      inputs.push(text);
      return `S${inputs.length}: ${text.slice(0, 40)}`;
    });

    assert.ok(inputs.length > 1, 'fifty long pages cannot fit one call');
    for (const input of inputs) assert.ok(input.length <= limit, `a call received ${input.length} characters`);
    assert.ok(result.startsWith('S'), 'the result is the final combined summary');
  });

  test('a single page longer than the limit is split at sentences', async () => {
    const inputs: string[] = [];
    await summariseWithin(['First sentence here. '.repeat(200)], 300, async (t) => { inputs.push(t); return 'ok'; });
    for (const input of inputs) assert.ok(input.length <= 300);
  });

  test('on desktop Chrome the on-device summariser is used and named', async () => {
    const inputs: string[] = [];
    installChrome('available', { inputs });
    const document = await contract();
    const result = await new PdfiumAI(document).summaries.summarize({ style: 'keyPoints' });

    assert.equal((result as { source: string }).source, 'onDevice');
    assert.deepEqual((result as unknown as { value: { pagesWithoutText: number[] } }).value.pagesWithoutText, [2]);
    assert.ok(inputs[0]!.includes('12.1 The notice period'));
    await document.close();
  });

  test('a page range summarises only those pages (SUM-1)', async () => {
    const inputs: string[] = [];
    installChrome('available', { inputs });
    const document = await contract();
    await new PdfiumAI(document).summaries.summarize({ pages: { from: 0, to: 0 } });
    assert.ok(inputs.join().includes('1. Parties'));
    assert.ok(!inputs.join().includes('12. Termination'));
    await document.close();
  });

  test('an unsupported language is unavailable with that reason, not a poor summary (SUM-3)', async () => {
    installChrome('available', { languages: ['en'] });
    const document = await contract();
    const ai = new PdfiumAI(document);
    const expected = { kind: 'unavailable', reason: 'languageNotSupported' };
    assert.deepEqual(await ai.summaries.availability('ja'), expected);
    assert.deepEqual(await ai.summaries.summarize({ language: 'ja' }), expected);
    await document.close();
  });

  test('outside Chrome and without a provider, summaries are unavailable', async () => {
    const document = await contract();
    const ai = new PdfiumAI(document);
    assert.deepEqual(await ai.summaries.availability(), { kind: 'unavailable', reason: 'noProvider' });
    assert.deepEqual(await ai.summaries.summarize(), { kind: 'unavailable', reason: 'noProvider' });
    await document.close();
  });

  test('outside Chrome a custom provider summarises instead', async () => {
    const document = await contract();
    const prompts: string[] = [];
    const ai = new PdfiumAI(document, {
      provider: { generate: async ({ prompt }) => { prompts.push(prompt); return { text: ' A contract. ' }; } },
    });
    const result = await ai.summaries.summarize();
    assert.deepEqual(result, { value: { text: 'A contract.', pagesWithoutText: [2] }, source: 'customProvider' });
    assert.ok(prompts[0]!.includes('Summarise the text below'));
    await document.close();
  });

  test('checking availability does not download; prepare does and reports progress (AVL-4)', async () => {
    let created = 0;
    installChrome('downloadable');
    const summarizer = (globalThis as unknown as { Summarizer: { create: (o?: unknown) => Promise<unknown> } }).Summarizer;
    const create = summarizer.create;
    summarizer.create = async (o) => { created++; return create(o); };

    const document = await contract();
    const ai = new PdfiumAI(document);
    assert.deepEqual(await ai.summaries.availability(), { kind: 'downloadable' });
    assert.equal(created, 0);

    const progress: number[] = [];
    await ai.summaries.prepare((f) => progress.push(f));
    assert.equal(created, 1);
    assert.deepEqual(progress, [0.5, 1]);
    await document.close();
  });
});
