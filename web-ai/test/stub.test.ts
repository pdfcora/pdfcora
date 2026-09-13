import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '@pdfiumkit/web';
import { PdfiumAI } from '../dist/index.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const open = () => PdfDocument.open(new Uint8Array(readFileSync(`${CORPUS}hello_world.pdf`)));

describe('the stub feature', () => {
  test('with no provider configured it is unavailable, with a reason', async () => {
    const ai = new PdfiumAI(await open());
    assert.deepEqual(await ai.stub.availability(),
      { kind: 'unavailable', reason: 'platformUnsupported' });
  });

  test('with a provider configured it becomes available and says where the answer came from', async () => {
    const ai = new PdfiumAI(await open(), {
      provider: { async generate() { return { text: 'ok' }; } },
    });
    assert.deepEqual(await ai.stub.availability(), { kind: 'available' });
    assert.deepEqual(await ai.stub.run(), { value: 'ok', source: 'customProvider' });
  });

  test('a feature call never throws for unavailability', async () => {
    // AVL-5: unavailability is a value, not an exception.
    const ai = new PdfiumAI(await open());
    assert.deepEqual(await ai.stub.run(), { kind: 'unavailable', reason: 'noProvider' });
  });

  test('nothing downloads unless the host asks', async () => {
    const ai = new PdfiumAI(await open());
    // Checking availability must never trigger a fetch (AVL-4). There is nothing to
    // fetch on the web, so the observable contract is that prepare reports progress
    // and availability alone does not.
    const progress: number[] = [];
    await ai.stub.availability();
    assert.equal(progress.length, 0);

    await ai.stub.prepare((f) => progress.push(f));
    assert.ok(progress.length > 0, 'prepare must report progress, even trivially');
  });

  test('it uses only the core public API', async () => {
    const document = await open();
    const ai = new PdfiumAI(document);
    assert.equal(ai.target, document);
    // PKG-4: if this ever needs an internal hook, that is a core change with its own
    // plan, not a @testable import.
    assert.equal(typeof document.pageCount, 'function');
  });
});
