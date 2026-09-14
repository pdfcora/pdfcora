import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';
import { PdfViewer } from '../dist/view/viewer.js';
import type { PdfViewEvent } from '../dist/view/state.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const bytes = () => new Uint8Array(readFileSync(`${CORPUS}hello_world.pdf`));

// The corpus pages are 200x200. Viewports must therefore be small enough, and zoom
// high enough, that the content actually overflows — otherwise the page fits entirely,
// there is nowhere to scroll, and every scroll assertion is vacuous.
const PHONE = { width: 390, height: 700 };
const WIDE = { width: 600, height: 500 };
const SCROLLABLE = { scale: 4, mode: 'free' } as const;   // 200pt page -> 800px content

const remote = (sequence: number, event: Partial<PdfViewEvent> & { change: PdfViewEvent['change'] }): PdfViewEvent =>
  ({ sequence, sessionId: 'them', origin: 'remote', ...event });

describe('the headless viewer', () => {
  let doc: PdfDocument;
  before(async () => { doc = await PdfDocument.open(bytes()); });

  test('every change emits exactly one event', async () => {
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    viewer.zoomIn();
    viewer.flush();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.change.kind, 'viewport');
    assert.equal(seen[0]!.origin, 'local');
  });

  test('applying a remote event emits nothing', async () => {
    // Without this, two synced viewers echo each other forever.
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    await viewer.apply(remote(1, {
      change: { kind: 'viewport', state: { ...viewer.state, zoom: { scale: 2, mode: 'free' } } },
    }));
    viewer.flush();

    assert.deepEqual(seen, []);
    assert.equal(viewer.state.zoom.scale, 2);
  });

  test('an out-of-order event does not rewind the view', async () => {
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    await viewer.apply(remote(5, { change: { kind: 'viewport', state: { ...viewer.state, zoom: { scale: 2, mode: 'free' } } } }));
    await viewer.apply(remote(3, { change: { kind: 'viewport', state: { ...viewer.state, zoom: { scale: 4, mode: 'free' } } } }));
    assert.equal(viewer.state.zoom.scale, 2, 'sequence 3 arrived late and must be ignored');
  });

  test('a peer on another screen lands on the same content', async () => {
    // The whole point. Same document, differently shaped windows, both scrollable.
    const phone = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    const wide = await PdfViewer.open(doc, WIDE, { throttleMs: 0 });

    phone.zoomTo(SCROLLABLE);
    phone.scrollTo({ x: 120, y: 90 });
    await wide.apply(remote(1, { change: { kind: 'viewport', state: phone.state } }));

    const centre = wide.transform().centerForScrollOffset(wide.scrollOffset(), WIDE);
    assert.ok(Math.abs(centre.x - 120) < 1, `centre x ${centre.x}`);
    assert.ok(Math.abs(centre.y - 90) < 1, `centre y ${centre.y}`);
  });

  test('fit-width is re-derived by the receiver, not adopted literally', async () => {
    const narrow = await PdfViewer.open(doc, { width: 300, height: 700 }, { throttleMs: 0 });
    const wide = await PdfViewer.open(doc, { width: 900, height: 700 }, { throttleMs: 0 });

    narrow.fitWidth();
    await wide.apply(remote(1, { change: { kind: 'viewport', state: narrow.state } }));

    assert.equal(wide.state.zoom.mode, 'fitWidth');
    assert.ok(wide.state.zoom.scale > narrow.state.zoom.scale,
              'the wide window fits its own width rather than adopting the narrow scale');
  });

  test('a free zoom is adopted verbatim', async () => {
    const wide = await PdfViewer.open(doc, WIDE, { throttleMs: 0 });
    await wide.apply(remote(1, {
      change: { kind: 'viewport', state: { ...wide.state, zoom: { scale: 2.4, mode: 'free' } } },
    }));
    assert.equal(wide.state.zoom.scale, 2.4);
  });

  test('resizing re-derives a fit but leaves a deliberate zoom alone', async () => {
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    viewer.fitWidth();
    const fitted = viewer.state.zoom.scale;
    await viewer.setViewport({ width: 780, height: 700 });
    assert.ok(viewer.state.zoom.scale > fitted, 'a fit follows the window');

    viewer.zoomTo({ scale: 1.5, mode: 'free' });
    await viewer.setViewport(PHONE);
    assert.equal(viewer.state.zoom.scale, 1.5, 'a deliberate zoom survives a resize');
  });

  test('viewport changes coalesce', async () => {
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 50 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    for (let i = 0; i < 100; i++) viewer.scrollBy({ x: 1, y: 1 });
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(seen.length < 10, `expected coalescing, got ${seen.length} events`);
    assert.ok(seen.length > 0, 'but the last one must still arrive');
  });

  test('selection and tool changes are not coalesced away', async () => {
    // Each is meaningful on its own; dropping one loses information.
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 50 });
    const seen: PdfViewEvent[] = [];
    viewer.on((e) => seen.push(e));

    viewer.setTool('ink');
    viewer.setTool('note');
    viewer.selectAnnotation(0, 1);

    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map((e) => e.change.kind), ['tool', 'tool', 'selection']);
  });

  test('scrolling past the page clamps rather than running away', async () => {
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    viewer.zoomTo(SCROLLABLE);
    for (let i = 0; i < 50; i++) viewer.scrollBy({ x: 500, y: 500 });

    const offset = viewer.scrollOffset();
    const content = viewer.transform().viewSize;
    // Both axes must genuinely be scrollable, or this asserts nothing.
    assert.ok(content.width > PHONE.width && content.height > PHONE.height);
    assert.ok(offset.x <= content.width - PHONE.width + 0.5, `x ran away: ${offset.x}`);
    assert.ok(offset.y <= content.height - PHONE.height + 0.5, `y ran away: ${offset.y}`);
  });

  test('a page index out of range is clamped, not thrown', async () => {
    const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
    await viewer.goToPage(99);
    assert.equal(viewer.state.pageIndex, 0, 'hello_world.pdf has one page');
  });
});
