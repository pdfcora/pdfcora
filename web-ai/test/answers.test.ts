import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '@pdfiumkit/web';
import { type PdfAiRequest, type PdfAnswer, PdfiumAI } from '../dist/index.js';
import { locateQuote } from '../dist/quote.js';
import { retrieve } from '../dist/retrieval.js';
import { passagesOf } from '../dist/text.js';

const FIXTURES = new URL('../../conformance/fixtures/', import.meta.url).pathname;
const contract = () => PdfDocument.open(new Uint8Array(readFileSync(`${FIXTURES}contract.pdf`)));
const NOTICE = 'The notice period is three months, ending on the last day of a calendar month.';

/** A provider that replies with whatever `reply` builds from the passages it was shown. */
function provider(reply: (prompt: string) => unknown) {
  const requests: PdfAiRequest[] = [];
  return {
    requests,
    generate: async (request: PdfAiRequest) => {
      requests.push(request);
      return { text: '', structured: reply(request.prompt) };
    },
  };
}

/** The id the prompt gave the passage containing `text`. */
function passageId(prompt: string, text: string): string {
  const line = prompt.split('\n').find((l) => l.includes(text));
  assert.ok(line, `no passage in the prompt contains: ${text}`);
  return line.match(/^\[([^\]]+)\]/)![1]!;
}

function answered(result: unknown): Extract<PdfAnswer, { kind: 'answered' }> {
  const value = (result as { value?: PdfAnswer }).value;
  assert.ok(value?.kind === 'answered', `expected an answer, got ${JSON.stringify(result)}`);
  return value;
}

describe('grounded answers', () => {
  test('the notice-period question highlights exactly that sentence and nothing else', async () => {
    const document = await contract();
    const model = provider((prompt) => ({
      answer: 'Three months, ending on the last day of a calendar month.',
      citations: [{ passage: passageId(prompt, NOTICE), quote: NOTICE }],
    }));
    const ai = new PdfiumAI(document, { provider: model });

    const result = await ai.answers.ask("What's the notice period?");
    const answer = answered(result);
    assert.equal((result as { source: string }).source, 'customProvider');
    assert.equal(answer.grounded, true);
    assert.equal(answer.citations.length, 1);

    const citation = answer.citations[0]!;
    assert.equal(citation.pageIndex, 1);
    assert.equal(citation.quote, NOTICE);
    const pageText = await (await document.page(1)).text.string();
    assert.equal(pageText.slice(citation.start, citation.end), NOTICE);
    assert.equal(citation.rects.length, 1, 'one line of text is one rectangle');
    // The sentence starts after "12.1 " on the second line (baseline 706) at x = 72.
    const rect = citation.rects[0]!;
    assert.ok(rect.left > 72 && rect.left < 110, `left edge ${rect.left} is not after "12.1 "`);
    assert.ok(rect.bottom >= 700 && rect.top <= 720, `rect ${JSON.stringify(rect)} is not on line two`);
    await document.close();
  });

  test('the prompt carries only retrieved passages, a schema, and the question', async () => {
    const document = await contract();
    const model = provider(() => ({ answer: '', citations: [] }));
    await new PdfiumAI(document, { provider: model }).answers.ask('When are invoices payable?');

    const request = model.requests[0]!;
    assert.ok(request.schema, 'structured output must be requested (ANS-2)');
    assert.ok(request.prompt.includes('Invoices are payable within thirty days of receipt.'));
    assert.ok(request.prompt.endsWith('Question: When are invoices payable?'));
    await document.close();
  });

  test('a question with no answer in the document is notFound, without calling the model', async () => {
    const document = await contract();
    const model = provider(() => assert.fail('the model must not be called (ANS-4)'));
    const result = await new PdfiumAI(document, { provider: model }).answers.ask('zeppelin xylophone?');

    assert.deepEqual(result, { value: { kind: 'notFound', pagesWithoutText: [2] }, source: 'rules' });
    assert.equal(model.requests.length, 0);
    await document.close();
  });

  test('a made-up quote never produces a highlight', async () => {
    const document = await contract();
    const model = provider((prompt) => ({
      answer: 'Six months.',
      citations: [{ passage: passageId(prompt, NOTICE), quote: 'The notice period is six months.' }],
    }));
    const answer = answered(await new PdfiumAI(document, { provider: model }).answers.ask("What's the notice period?"));

    assert.equal(answer.citations.length, 0);
    assert.equal(answer.grounded, false);
    await document.close();
  });

  // Apple's model quoted correctly but named passages "p1-3" and "13. Payment": ids are
  // what it gets wrong, so the quote, not the id, decides.
  test('a quote credited to the wrong or an unknown passage is found in the passages shown', async () => {
    const document = await contract();
    for (const id of [(prompt: string) => passageId(prompt, 'maintenance services'), () => '13. Payment']) {
      const model = provider((prompt) => ({ answer: 'Three months.', citations: [{ passage: id(prompt), quote: NOTICE }] }));
      const answer = answered(await new PdfiumAI(document, { provider: model }).answers.ask(
        'What is the notice period for the maintenance services?'));

      assert.equal(answer.grounded, true);
      assert.equal(answer.citations[0]!.pageIndex, 1);
      assert.equal(answer.citations[0]!.quote, NOTICE);
    }
    await document.close();
  });

  test('a real sentence the model was not shown is never a citation', async () => {
    const document = await contract();
    const START = 'The agreement starts on 1 March 2026 and runs for an initial term of two years.';
    const model = provider((prompt) => {
      assert.ok(!prompt.includes('1 March 2026'), 'the budget should admit only the page-2 passage');
      return { answer: 'Three months.', citations: [{ passage: passageId(prompt, NOTICE), quote: START }] };
    });
    // Room for one passage, so page 1 is never in the prompt.
    const ai = new PdfiumAI(document, { provider: model, providerContextTokens: 200 });
    const answer = answered(await ai.answers.ask('What is the notice period?'));

    assert.equal(answer.citations.length, 0);
    assert.equal(answer.grounded, false);
    await document.close();
  });

  // Apple's model answers "not mentioned in the passages" instead of the empty answer the
  // prompt asks for. Without a citation there is nothing to verify or highlight.
  test('an answer with no citations is notFound, whatever its text says', async () => {
    const document = await contract();
    const model = provider(() => ({ answer: 'The capital of France is not mentioned in the passages.', citations: [] }));
    const result = await new PdfiumAI(document, { provider: model }).answers.ask('What is the notice period?');

    assert.deepEqual(result, { value: { kind: 'notFound', pagesWithoutText: [2] }, source: 'customProvider' });
    await document.close();
  });

  test('pages without a text layer are reported (ANS-6)', async () => {
    const document = await contract();
    const model = provider((prompt) => ({
      answer: 'Three months.', citations: [{ passage: passageId(prompt, NOTICE), quote: NOTICE }],
    }));
    const answer = answered(await new PdfiumAI(document, { provider: model }).answers.ask('notice period'));
    assert.deepEqual(answer.pagesWithoutText, [2]);
    await document.close();
  });

  test('without a provider, answers are unavailable as a value, not an exception', async () => {
    const document = await contract();
    const ai = new PdfiumAI(document);
    assert.deepEqual(await ai.answers.availability(), { kind: 'unavailable', reason: 'noProvider' });
    assert.deepEqual(await ai.answers.ask('notice period'), { kind: 'unavailable', reason: 'noProvider' });
    await document.close();
  });

  test('a reply that is JSON in text, fenced, is read too', async () => {
    const document = await contract();
    const ai = new PdfiumAI(document, {
      provider: {
        generate: async (request: PdfAiRequest) => ({
          text: '```json\n' + JSON.stringify({
            answer: 'Three months.',
            citations: [{ passage: passageId(request.prompt, NOTICE), quote: NOTICE }],
          }) + '\n```',
        }),
      },
    });
    assert.equal(answered(await ai.answers.ask('notice period')).grounded, true);
    await document.close();
  });
});

describe('quote verification', () => {
  test('tolerates whitespace and line breaks', () => {
    const source = 'Intro.  The notice\r\nperiod   is three months.';
    const found = locateQuote(source, 'The notice period is three months.');
    assert.deepEqual(found, { start: 8, end: source.length });
  });

  test('tolerates a word hyphenated across a line', () => {
    const source = 'Payment on manage-\nment approval.';
    const found = locateQuote(source, 'Payment on management approval.');
    assert.deepEqual(found, { start: 0, end: source.length });
  });

  test('keeps a compound that happens to break at a line end', () => {
    const source = 'A well-\nknown supplier.';
    assert.deepEqual(locateQuote(source, 'A well-known supplier.'), { start: 0, end: source.length });
  });

  test('does not tolerate different words, punctuation or case', () => {
    const source = 'The notice period is three months.';
    assert.equal(locateQuote(source, 'The notice period is 3 months.'), null);
    assert.equal(locateQuote(source, 'The notice period is three months!'), null);
    assert.equal(locateQuote(source, 'the notice period is three months.'), null);
    assert.equal(locateQuote(source, '   '), null);
  });
});

describe('retrieval', () => {
  const passages = passagesOf({
    pageIndex: 0,
    text: 'Invoices are payable within thirty days. The notice period is three months. Deliveries arrive weekly.',
  });

  test('ranks the passage sharing the question\'s rare terms first', () => {
    const small = [0, 1, 2].map((i) => passagesOf({ pageIndex: i, text: [
      'Invoices are payable within thirty days.',
      'The notice period is three months.',
      'Deliveries arrive weekly.',
    ][i]! })[0]!);
    const picked = retrieve(small, 'How long is the notice period?', 10_000);
    assert.equal(picked[0]!.text, 'The notice period is three months.');
    assert.ok(!picked.some((p) => p.text.startsWith('Deliveries')), 'a passage with no shared term is not retrieved');
  });

  test('stops at the budget', () => {
    assert.deepEqual(retrieve(passages, 'notice period', 5), []);
  });

  test('passages keep their character range in the page', () => {
    const text = 'One.  Two words here.';
    const [passage] = passagesOf({ pageIndex: 3, text });
    assert.equal(text.slice(passage!.start, passage!.end), passage!.text);
  });
});
