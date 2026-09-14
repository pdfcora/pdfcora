import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';
import { PdfViewer } from '../dist/view/viewer.js';
import type { PdfViewEvent } from '../dist/view/state.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const bytes = (name = 'hello_world.pdf') => new Uint8Array(readFileSync(`${CORPUS}${name}`));
const PHONE = { width: 390, height: 700 };
const DESKTOP = { width: 1200, height: 800 };
const RECT = { left: 10, bottom: 10, right: 30, top: 30 };

describe('replaying an edit on a peer', () => {
  test('the same document opened twice shares a fingerprint', async () => {
    const a = await PdfDocument.open(bytes());
    const b = await PdfDocument.open(bytes());
    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprint, (await PdfDocument.open(bytes('text_form.pdf'))).fingerprint);
  });

  test('an applied edit reproduces the change on the peer', async () => {
    const a = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    const bDocument = await PdfDocument.open(bytes());
    const b = await PdfViewer.open(bDocument, DESKTOP, { throttleMs: 0 });

    const sent: PdfViewEvent[] = [];
    a.on((e) => sent.push(e));
    const echoed: PdfViewEvent[] = [];
    b.on((e) => echoed.push(e));

    await a.addNote(RECT, 'hello');
    await b.apply({ ...sent[0]!, origin: 'remote' });

    assert.deepEqual(echoed, [], 'applying must not echo');
    assert.equal((await (await bDocument.page(0)).annotations()).length, 1);
  });

  test('every edit kind replays', async () => {
    const source = await PdfViewer.open(await PdfDocument.open(bytes('text_form.pdf')), PHONE, { throttleMs: 0 });
    const peerDocument = await PdfDocument.open(bytes('text_form.pdf'));
    const peer = await PdfViewer.open(peerDocument, PHONE, { throttleMs: 0 });

    const sent: PdfViewEvent[] = [];
    source.on((e) => sent.push(e));

    await source.addNote(RECT, 'n');
    await source.addInk([{ x: 1, y: 1 }, { x: 2, y: 2 }]);
    await source.addHighlight([{ p1: { x: 1, y: 2 }, p2: { x: 3, y: 2 },
                                 p3: { x: 1, y: 1 }, p4: { x: 3, y: 1 } }]);
    await source.setFieldText('typed', 0);

    for (const event of sent) await peer.apply({ ...event, origin: 'remote' });

    // The peer performed the same calls, so it holds the same document.
    assert.deepEqual(await peerDocument.toBytes('full'),
                     await (source as unknown as { document: PdfDocument }).document.toBytes('full'));
  });

  test('an edit for a different document is refused, not applied', async () => {
    // Indices are positions in specific bytes. Replaying annotationRemoved(0) against
    // other bytes removes the wrong thing, silently.
    const other = await PdfViewer.open(await PdfDocument.open(bytes('text_form.pdf')), PHONE, { throttleMs: 0 });
    const mine = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    assert.notEqual(other.documentFingerprint, mine.documentFingerprint);

    await assert.rejects(() => mine.apply({
      sequence: 1, sessionId: 'them', origin: 'remote',
      documentFingerprint: other.documentFingerprint,
      change: { kind: 'edit', edit: { kind: 'annotationRemoved', page: 0, index: 0 } },
    }), /different document/);
  });

  test('a viewport event is accepted across different documents', async () => {
    // Only edits depend on the bytes. Two people reading different documents can still
    // be told where the other is looking, and refusing that would be over-strict.
    const mine = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    await mine.apply({
      sequence: 1, sessionId: 'them', origin: 'remote',
      documentFingerprint: 'something-else-entirely',
      change: { kind: 'viewport', state: { ...mine.state, zoom: { scale: 2, mode: 'free' } } },
    });
    assert.equal(mine.state.zoom.scale, 2);
  });

  test('a refused edit does not consume the sequence number', async () => {
    // Otherwise a rejected event would make the peer ignore the sender's next one.
    const mine = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    await assert.rejects(() => mine.apply({
      sequence: 5, sessionId: 'them', origin: 'remote',
      documentFingerprint: 'wrong',
      change: { kind: 'edit', edit: { kind: 'annotationRemoved', page: 0, index: 0 } },
    }));

    await mine.apply({
      sequence: 5, sessionId: 'them', origin: 'remote',
      change: { kind: 'viewport', state: { ...mine.state, zoom: { scale: 3, mode: 'free' } } },
    });
    assert.equal(mine.state.zoom.scale, 3, 'sequence 5 must still be accepted');
  });
});
