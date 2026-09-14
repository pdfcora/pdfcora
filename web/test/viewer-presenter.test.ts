import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';
import { PdfViewer } from '../dist/view/viewer.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const bytes = () => new Uint8Array(readFileSync(`${CORPUS}hello_world.pdf`));
const PHONE = { width: 390, height: 700 };
const RECT = { left: 10, bottom: 10, right: 30, top: 30 };

describe('the presenter rule', () => {
  test('a follower cannot edit', async () => {
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE,
                                        { throttleMs: 0, role: 'follower' });
    await assert.rejects(() => viewer.addNote(RECT, 'nope'), /follower/);
    await assert.rejects(() => viewer.redact([]), /follower/);
  });

  test('a follower may still scroll and zoom its own view', async () => {
    // Following is not being frozen: reading a different part of the page is normal.
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE,
                                        { throttleMs: 0, role: 'follower' });
    viewer.zoomIn();
    viewer.scrollBy({ x: 10, y: 10 });
    assert.ok(viewer.state.zoom.scale > 0);
  });

  test('a presenter is the default, so nothing changes for a single user', async () => {
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    await viewer.addNote(RECT, 'fine');
  });

  test('an edit from someone who is not the presenter is ignored', async () => {
    const document = await PdfDocument.open(bytes());
    const viewer = await PdfViewer.open(document, PHONE,
                                        { throttleMs: 0, role: 'follower', presenterId: 'boss' });

    await viewer.apply({
      sequence: 1, sessionId: 'someone-else', origin: 'remote',
      documentFingerprint: viewer.documentFingerprint,
      change: { kind: 'edit', edit: { kind: 'noteAdded', page: 0, rect: RECT,
                                      contents: 'sneaky', color: { red: 1, green: 2, blue: 3 } } },
    });
    assert.equal((await (await document.page(0)).annotations()).length, 0, 'nothing was added');
  });

  test('an edit from the presenter is applied', async () => {
    const document = await PdfDocument.open(bytes());
    const viewer = await PdfViewer.open(document, PHONE,
                                        { throttleMs: 0, role: 'follower', presenterId: 'boss' });

    await viewer.apply({
      sequence: 1, sessionId: 'boss', origin: 'remote',
      documentFingerprint: viewer.documentFingerprint,
      change: { kind: 'edit', edit: { kind: 'noteAdded', page: 0, rect: RECT,
                                      contents: 'allowed', color: { red: 1, green: 2, blue: 3 } } },
    });
    assert.equal((await (await document.page(0)).annotations()).length, 1);
  });

  test('a stray edit is ignored rather than thrown', async () => {
    // In a broadcast transport everyone hears everyone. Throwing would turn a third
    // participant's stray edit into an error on every peer.
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE,
                                        { throttleMs: 0, presenterId: 'boss' });
    await viewer.apply({
      sequence: 1, sessionId: 'nobody', origin: 'remote',
      documentFingerprint: viewer.documentFingerprint,
      change: { kind: 'edit', edit: { kind: 'annotationRemoved', page: 0, index: 0 } },
    });
  });
});
