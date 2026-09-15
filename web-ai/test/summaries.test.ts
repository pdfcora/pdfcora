import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '@pdfiumkit/web';
import { PdfiumAI } from '../dist/index.js';
import { summariseInWindows } from '../dist/summaries.js';

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

  // Long documents are read in windows: each call carries the summary so far and the next
  // stretch of text, so later parts are summarised knowing what came before (SUM-2).
  const pages = Array.from({ length: 30 }, (_, i) => `Marker${i} opens this page. ` + 'Clause text goes here. '.repeat(40));
  const NEXT = 'Next part:\n';

  /** The page markers in the document text of each call, leaving out the summary it carries. */
  const markers = (inputs: readonly string[]) => inputs
    .map((input) => input.includes(NEXT) ? input.slice(input.indexOf(NEXT) + NEXT.length) : input)
    .flatMap((text) => [...text.matchAll(/Marker(\d+)/g)].map((m) => Number(m[1])));

  async function windows(limit: number, reply: (input: string, call: number) => string) {
    const inputs: string[] = [];
    const outputs: string[] = [];
    const result = await summariseInWindows(pages, limit, async (input: string) => {
      inputs.push(input);
      outputs.push(reply(input, inputs.length));
      return outputs[outputs.length - 1]!;
    });
    return { inputs, outputs, result };
  }

  test('every call stays within the limit and the last summary is the result', async () => {
    const { inputs, outputs, result } = await windows(2_000, (_, call) => `S${call}`);
    assert.ok(inputs.length > 1, 'thirty long pages cannot fit one window');
    for (const input of inputs) assert.ok(input.length <= 2_000, `a call received ${input.length} characters`);
    assert.equal(result, outputs[outputs.length - 1]);
  });

  test('each window after the first carries the summary of everything before it', async () => {
    const { inputs, outputs } = await windows(2_000, (_, call) => `S${call}`);
    assert.ok(!inputs[0]!.includes(NEXT), 'the first window is plain text');
    for (let i = 1; i < inputs.length; i++) {
      assert.ok(inputs[i]!.startsWith(`Summary of the earlier parts:\n${outputs[i - 1]}\n\n${NEXT}`), `call ${i + 1}`);
    }
  });

  test('every page is read exactly once, in order', async () => {
    const { inputs } = await windows(2_000, (_, call) => `S${call}`);
    assert.deepEqual(markers(inputs), pages.map((_, i) => i));
  });

  test('a summary that grows too long is condensed before it crowds out the text', async () => {
    const limit = 2_000;
    // A summariser that keeps almost everything, so the summary soon fills the window.
    const { inputs, result } = await windows(limit, (input) => 'kept. '.repeat(Math.floor(input.length / 7)));
    for (const input of inputs) assert.ok(input.length <= limit, `a call received ${input.length} characters`);
    assert.ok(inputs.some((input) => !input.includes(NEXT) && input.startsWith('kept.')), 'the summary was condensed');
    assert.deepEqual(markers(inputs), pages.map((_, i) => i), 'no page is lost to condensing');
    assert.ok(result.length > 0);
  });

  test('a document that fits one window is one call with the plain text', async () => {
    const inputs: string[] = [];
    const result = await summariseInWindows(['A short page.', 'Another page.'], 2_000, async (t: string) => { inputs.push(t); return 'ok'; });
    assert.deepEqual(inputs, ['A short page.\n\nAnother page.']);
    assert.equal(result, 'ok');
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
