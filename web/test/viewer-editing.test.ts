import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';
import { PdfViewer } from '../dist/view/viewer.js';
import type { PdfViewEvent } from '../dist/view/state.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const bytes = (name = 'hello_world.pdf') => new Uint8Array(readFileSync(`${CORPUS}${name}`));
const PHONE = { width: 390, height: 700 };
const RECT = { left: 10, bottom: 10, right: 30, top: 30 };

describe('editing through the viewer', () => {
  test('an edit emits immediately and is not coalesced away', async () => {
    // Viewport changes may be dropped in favour of a later one. An annotation added is
    // not superseded by the next, and dropping it loses data. A one-second viewport
    // throttle makes the distinction unambiguous.
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 1000 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    await viewer.addNote(RECT, 'one');
    await viewer.addNote({ left: 40, bottom: 10, right: 60, top: 30 }, 'two');

    assert.equal(seen.length, 2, 'both edits, despite the throttle');
    assert.deepEqual(seen.map((e) => e.change.kind), ['edit', 'edit']);
  });

  test('an edit through the viewer reaches the document', async () => {
    const document = await PdfDocument.open(bytes());
    const viewer = await PdfViewer.open(document, PHONE, { throttleMs: 0 });
    const before = (await (await document.page(0)).annotations()).length;

    await viewer.addNote(RECT, 'hello');
    assert.equal((await (await document.page(0)).annotations()).length, before + 1);
  });

  test('the event carries what a peer needs to replay the call', async () => {
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    await viewer.addInk([[{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: 5, y: 6 }]], { red: 0, green: 90, blue: 220 }, 3);
    const change = seen[0]!.change;
    assert.equal(change.kind, 'edit');
    if (change.kind !== 'edit' || change.edit.kind !== 'inkAdded') return assert.fail('wrong edit');
    assert.deepEqual(change.edit.strokes, [[{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: 5, y: 6 }]]);
    assert.equal(change.edit.lineWidth, 3);
    assert.deepEqual(change.edit.color, { red: 0, green: 90, blue: 220 });
  });

  test('every edit kind emits exactly one event', async () => {
    const document = await PdfDocument.open(bytes('text_form.pdf'));
    const viewer = await PdfViewer.open(document, PHONE, { throttleMs: 0 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    await viewer.addNote(RECT, 'n');
    await viewer.addInk([[{ x: 1, y: 1 }, { x: 2, y: 2 }]]);
    await viewer.addHighlight([{ p1: { x: 1, y: 2 }, p2: { x: 3, y: 2 },
                                p3: { x: 1, y: 1 }, p4: { x: 3, y: 1 } }]);
    await viewer.setFieldText('typed', 0);
    await viewer.removeAnnotation(0);

    assert.equal(seen.length, 5);
    assert.deepEqual(seen.map((e) => (e.change.kind === 'edit' ? e.change.edit.kind : '?')),
                     ['noteAdded', 'inkAdded', 'highlightAdded', 'fieldTextSet', 'annotationRemoved']);
  });

  test('redaction through the viewer removes content from the saved bytes', async () => {
    // The claim redaction exists for, asserted on the bytes and never the text layer.
    const document = await PdfDocument.open(bytes());
    const viewer = await PdfViewer.open(document, PHONE, { throttleMs: 0 });
    const objects = await (await document.page(0)).objects();
    const target = objects.find((o) => o.text?.includes('Goodbye'));
    assert.ok(target, 'fixture must contain the text being redacted');

    const report = await viewer.redact([{ kind: 'region', rect: target.bounds, pageIndex: 0 }]);
    assert.equal(report.textObjects, 1);

    const saved = await document.toBytes('full');
    assert.ok(!Buffer.from(saved).toString('latin1').includes('Goodbye'),
              'still in the file bytes');
  });

  test('sequence numbers advance across edits and viewport changes alike', async () => {
    const viewer = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    await viewer.addNote(RECT, 'one');
    viewer.zoomIn();
    viewer.flush();
    await viewer.addNote({ left: 40, bottom: 10, right: 60, top: 30 }, 'two');

    // A peer orders by sequence, so a shared counter across change kinds is what makes
    // "this edit happened after that scroll" meaningful.
    assert.deepEqual(seen.map((e) => e.sequence), [1, 2, 3]);
  });
});
