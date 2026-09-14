import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PdfError, PdfWorker } from '../dist/index.js';

/**
 * PDFium can hang inside a single call, and the worker runs one call at a time, so a
 * hung call would leave every later call pending forever. The client treats a worker
 * that answers nothing for `callTimeoutMs` as hung.
 *
 * Node has no browser Worker, so these drive the client against a stand-in that answers
 * `init` and then answers each call after `replyAfterMs`, or never.
 */
class FakeWorker {
  static replyAfterMs: number | undefined;
  static last: FakeWorker;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  /** Like the real worker, one call at a time. */
  private busyUntil = 0;

  constructor() { FakeWorker.last = this; }

  postMessage(message: { id: number; op: string }): void {
    const delay = message.op === 'init' ? 0 : FakeWorker.replyAfterMs;
    if (delay === undefined) return;
    const result = message.op === 'open' ? { docId: 1, pageCount: 1 } : 1;
    this.busyUntil = Math.max(Date.now(), this.busyUntil) + delay;
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: { id: message.id, ok: true, result } });
    }, this.busyUntil - Date.now());
  }

  terminate(): void { this.terminated = true; }
}

(globalThis as { Worker?: unknown }).Worker = FakeWorker;
const urls = { workerUrl: 'w.js', glueUrl: 'g.js', wasmUrl: 'p.wasm' };

describe('worker watchdog', () => {
  test('a worker that stops answering is terminated and pending calls reject', async () => {
    FakeWorker.replyAfterMs = undefined;
    const worker = new PdfWorker({ ...urls, callTimeoutMs: 100 });

    const opening = worker.open(new Uint8Array([1]));
    await assert.rejects(opening, (error: unknown) =>
      error instanceof PdfError && error.code === 'engineUnresponsive');
    assert.ok(worker.isTerminated);
    assert.ok(FakeWorker.last.terminated);
  });

  test('a busy worker that keeps answering is not mistaken for a hung one', async () => {
    FakeWorker.replyAfterMs = 60;
    const worker = new PdfWorker({ ...urls, callTimeoutMs: 100 });
    const document = await worker.open(new Uint8Array([1]));

    // Five calls queued at once take 300ms in total, well past the timeout, but the
    // worker answers one every 60ms.
    const counts = await Promise.all(Array.from({ length: 5 }, () => document.pageCount()));
    assert.deepEqual(counts, [1, 1, 1, 1, 1]);
    assert.ok(!worker.isTerminated);
    worker.terminate();
  });
});
