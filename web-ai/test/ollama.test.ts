import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '@pdfcora/web';
import { type PdfAiProvider, PdfAI } from '../dist/index.js';

/**
 * The grounded-answer contract against a real model behind the custom provider interface.
 * Opt-in, since it needs a model: `OLLAMA_MODEL=llama3.2:3b npm test` with Ollama running.
 * `OLLAMA_REPEAT` sets how often each question is asked (default 5).
 */
const MODEL = process.env.OLLAMA_MODEL;
const URL_BASE = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const REPEAT = Number(process.env.OLLAMA_REPEAT ?? 5);
const FIXTURES = new URL('../../conformance/fixtures/', import.meta.url).pathname;

/** What an app writes to use Ollama: the whole provider. */
function ollama(model: string): PdfAiProvider {
  return {
    async generate(request) {
      const response = await fetch(`${URL_BASE}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: request.prompt }],
          // Ollama constrains the output to a JSON Schema passed as `format`.
          ...(request.schema ? { format: request.schema } : {}),
          options: { temperature: 0 },
        }),
      });
      if (!response.ok) throw new Error(`ollama: HTTP ${response.status}`);
      const text = ((await response.json()) as { message: { content: string } }).message.content;
      return { text, structured: request.schema ? JSON.parse(text) : undefined };
    },
  };
}

const QUESTIONS: ReadonlyArray<readonly [string, string]> = [
  ['Who are the parties to the agreement?', 'Example Holdings Ltd'],
  ['When does the agreement start?', '1 March 2026'],
  ['What is the notice period?', 'notice period is three months'],
  ['How must notice be given?', 'registered address'],
  ['When are invoices payable?', 'thirty days'],
  ['What interest do late payments carry?', 'four percent'],
];

test(`grounded answers from ${MODEL ?? 'a real model'} through the custom provider`, { skip: !MODEL }, async () => {
  const document = await PdfDocument.open(new Uint8Array(readFileSync(`${FIXTURES}contract.pdf`)));
  const ai = new PdfAI(document, { provider: ollama(MODEL!) });
  const report: string[] = [];
  let grounded = 0;
  let asked = 0;

  for (const [question, expected] of QUESTIONS) {
    for (let i = 0; i < REPEAT; i++) {
      asked++;
      const started = Date.now();
      const result = await ai.answers.ask(question);
      const value = 'value' in result ? result.value : undefined;
      const onExpected = value?.kind === 'answered' && value.grounded
        && value.citations.some((c) => c.quote.includes(expected));
      if (onExpected) grounded++;
      report.push(`${onExpected ? 'grounded' : 'MISSED  '} ${Date.now() - started}ms ${question} → ${JSON.stringify(value ?? result)}`);
      // Whatever the model says, a citation the SDK reports is text from the document.
      if (value?.kind === 'answered') {
        for (const c of value.citations) {
          const page = await (await document.page(c.pageIndex)).text.string();
          assert.equal(page.slice(c.start, c.end), c.quote);
        }
      }
    }
  }

  let notFound = 0;
  for (let i = 0; i < REPEAT; i++) {
    const result = await ai.answers.ask('Which court has jurisdiction over disputes?');
    const value = 'value' in result ? result.value : undefined;
    if (value?.kind === 'notFound') notFound++;
    report.push(`${value?.kind === 'notFound' ? 'notFound' : 'ANSWERED'} unanswerable → ${JSON.stringify(value ?? result)}`);
  }

  for (const kind of ['paragraph', 'keyPoints'] as const) {
    const started = Date.now();
    const summary = await ai.summaries.summarize({ style: kind });
    report.push(`summary ${kind} ${Date.now() - started}ms → ${JSON.stringify(summary)}`);
  }

  console.log(report.join('\n'));
  console.log(`grounded on the expected sentence: ${grounded} of ${asked}; unanswerable notFound: ${notFound} of ${REPEAT}`);
  await document.close();
});
