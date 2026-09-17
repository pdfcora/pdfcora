# Viewer State and Transform Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Take the scroll position and zoom out of one viewer, and put them into another
on a different platform with a different screen — with no viewer class yet. Phases 1–2 of
the spec: the state model, the two inverse transform functions, and the headless
`PdfViewer` with viewing operations only.

**Architecture:** View state lives in document space (which page, what point is at the
centre) so it survives a change of screen. Pure logic with no engine calls, so it is
built in TypeScript first and ported, as signatures and redaction were. The viewer is an
actor on iOS because `PdfDocument` is one.

**Tech Stack:** TypeScript/Node, Swift, Kotlin.

**Spec:** `docs/superpowers/specs/2026-09-14-viewer-and-sync-design.md` §§4–6, 9

## What was verified before writing this

| Claim | Result |
| --- | --- |
| All three platforms already have `PdfViewTransform` with the same shape | ✅ `pageSize` + `scale`, a fit-width factory, `toView`/`toPdf` on each |
| It has no viewport or scroll concept to build on | ✅ its whole surface is `viewSize`, `toView`, `toPdf`, `contains` |
| `PdfDocument` is an actor on iOS | ✅ `public actor PdfDocument` — so the viewer is an actor too, and must not hold its executor while awaiting the document's |
| `PdfPage` is a value type | ✅ `public struct PdfPage: Sendable` |
| `render` returns the platform's own image type | ✅ `UIImage` on iOS; there is no cross-platform image type and this plan does not add one |
| No layout or tool type exists in the SDK | ✅ both are new; the tool enum currently exists three times in demo code |
| Scale is `Double` on iOS and web, `Float` on Android | ⚠️ the codec must not assume precision parity — see Task 5 |

## Which task covers which part of the spec

| Spec | Task |
| --- | --- |
| §4.1 Zoom | 1 |
| §4.2 View state · §4.3 Selection · §4.4 Events | 3 |
| §5 The viewer · §6 Coalescing | 4 |
| §5.1 Scroll, both directions | 2 |
| §7 Encoding | 5 |
| §9 Testing — round trip | 2 |
| §9 Testing — cross-platform, echo, ordering | 4, 8 |
| §4.5 Edit events · §8 Presenter rule | **not this plan** — phases 3–4 |

## Global Constraints

- **A scroll offset is never synced.** It is in the sending viewer's pixels and means
  nothing elsewhere. Only `pageIndex` + `center` + `zoom` cross a boundary.
- **The percentage is a label.** Nothing in rendering or state reads it. Two helpers
  exist; neither is authoritative.
- **The viewer delegates.** Every edit calls the existing `PdfDocument`/`PdfPage` API.
  A second implementation would drift.
- **No view types.** No `UIView`, `@Composable` or custom element on any platform.
- Applying a remote change must emit nothing. Anything else loops.

---

## Task 1: Zoom (web)

**Files:**
- Create: `web/src/view/zoom.ts`
- Test: `web/test/zoom.test.ts`

**Interfaces:**
- Produces: `PdfZoomMode`, `PdfZoom`, `fittingWidth()`, `fittingSize()`, `steps`,
  `percentage()`, `percentageOfFit()`, `stepped()`

- [ ] **Step 1: Write the failing test**

```ts
test('fit-width derives the scale that fills the width', () => {
  const zoom = fittingWidth(390, { width: 612, height: 792 });
  assert.equal(zoom.mode, 'fitWidth');
  assert.ok(Math.abs(zoom.scale - 390 / 612) < 1e-9);
});

test('the two percentage helpers answer different questions', () => {
  const page = { width: 612, height: 792 };
  const phone = fittingWidth(390, page);
  // 1:1 based — what Acrobat shows. A phone's normal view is not 100%.
  assert.equal(percentage(phone), 64);
  // Fit based — what a viewer shows. Always 100% at fit, on any screen.
  assert.equal(percentageOfFit(phone, phone.scale), 100);
});

test('a degenerate page cannot produce an infinite scale', () => {
  // An infinite or NaN scale silently poisons every later coordinate.
  assert.equal(fittingWidth(390, { width: 0, height: 792 }).scale, 1);
});

test('stepping moves through the ladder and clamps at both ends', () => {
  const page = { width: 612, height: 792 };
  const one = { scale: 1, mode: 'free' as const };
  assert.equal(stepped(one, +1).scale, 1.25);
  assert.equal(stepped({ scale: 4, mode: 'free' }, +1).scale, 4);
  assert.equal(stepped({ scale: 0.25, mode: 'free' }, -1).scale, 0.25);
  // Stepping away from a fit leaves fit behind: the number is now deliberate.
  assert.equal(stepped(fittingWidth(390, page), +1).mode, 'free');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL, cannot find module `../dist/view/zoom.js`

- [ ] **Step 3: Implement**

```ts
import type { PdfSize } from '../types.js';

export type PdfZoomMode = 'fitWidth' | 'fitPage' | 'free';

export interface PdfZoom {
  /** View pixels per PDF point. 1.0 is 1:1. */
  readonly scale: number;
  /** How this zoom was arrived at — what a peer reproduces. */
  readonly mode: PdfZoomMode;
}

export const steps: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function fittingWidth(width: number, page: PdfSize): PdfZoom {
  // A degenerate page would otherwise give an infinite or NaN scale, which silently
  // poisons every coordinate derived from it.
  return { scale: page.width > 0 ? width / page.width : 1, mode: 'fitWidth' };
}

export function fittingSize(size: { width: number; height: number }, page: PdfSize): PdfZoom {
  const byWidth = page.width > 0 ? size.width / page.width : 1;
  const byHeight = page.height > 0 ? size.height / page.height : 1;
  return { scale: Math.min(byWidth, byHeight), mode: 'fitPage' };
}

/** 1:1 based, as Acrobat and Preview mean it. */
export function percentage(zoom: PdfZoom): number {
  return Math.round(zoom.scale * 100);
}

/** Fit based, as most viewers mean it. 100% is whatever fills the window. */
export function percentageOfFit(zoom: PdfZoom, fitScale: number): number {
  return fitScale > 0 ? Math.round((zoom.scale / fitScale) * 100) : 100;
}

/**
 * Moves one place along the ladder.
 *
 * The result is always `free`: the user picked this number, so a peer must adopt it
 * rather than re-deriving a fit from its own window.
 */
export function stepped(zoom: PdfZoom, direction: 1 | -1): PdfZoom {
  const at = steps.findIndex((s) => s > zoom.scale + 1e-9);
  const from = at < 0 ? steps.length - 1 : (direction > 0 ? at - 1 : at);
  const next = Math.min(steps.length - 1, Math.max(0, from + direction));
  return { scale: steps[next]!, mode: 'free' };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/view/zoom.ts web/test/zoom.test.ts
git commit -m "Add the zoom model"
```

---

## Task 2: Scroll, both directions (web)

The two functions that make take-from-one/apply-to-another work.

**Files:**
- Modify: `web/src/types.ts` — add two methods to `PdfViewTransform`
- Test: `web/test/scroll-roundtrip.test.ts`

**Interfaces:**
- Produces: `PdfViewTransform.centerForScrollOffset(offset, viewport)`,
  `PdfViewTransform.scrollOffsetCentering(center, viewport)`

- [ ] **Step 1: Write the failing property test**

```ts
test('offset -> centre -> offset lands where it started', () => {
  // The property that makes cross-platform sync possible. Swept rather than
  // spot-checked: a single example passes with the wrong formula.
  for (const page of [{ width: 612, height: 792 }, { width: 200, height: 1000 }]) {
    for (const scale of [0.25, 0.64, 1, 1.96, 4]) {
      for (const viewport of [{ width: 390, height: 700 }, { width: 1200, height: 800 }]) {
        const t = new PdfViewTransform(page, scale);
        const content = t.viewSize;
        for (const offset of [
          { x: 0, y: 0 },
          { x: Math.max(0, content.width - viewport.width), y: Math.max(0, content.height - viewport.height) },
          { x: (content.width - viewport.width) / 2, y: (content.height - viewport.height) / 2 },
        ]) {
          const centre = t.centerForScrollOffset(offset, viewport);
          const back = t.scrollOffsetCentering(centre, viewport);
          assert.ok(Math.abs(back.x - clampX(offset.x)) < 0.5, `x ${back.x} vs ${offset.x}`);
          assert.ok(Math.abs(back.y - clampY(offset.y)) < 0.5, `y ${back.y} vs ${offset.y}`);
        }
      }
    }
  }
});

test('a centre near the edge clamps into the scrollable range', () => {
  // A peer with a differently shaped window must land as close as it can, not at an
  // offset outside its own content.
  const t = new PdfViewTransform({ width: 612, height: 792 }, 1);
  const offset = t.scrollOffsetCentering({ x: 0, y: 792 }, { width: 1200, height: 800 });
  assert.equal(offset.x, 0);
  assert.equal(offset.y, 0);
});

test('a viewport larger than the page centres it rather than scrolling', () => {
  const t = new PdfViewTransform({ width: 612, height: 792 }, 0.5);
  const offset = t.scrollOffsetCentering({ x: 306, y: 396 }, { width: 1200, height: 900 });
  assert.equal(offset.x, 0);
  assert.equal(offset.y, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL, `centerForScrollOffset is not a function`

- [ ] **Step 3: Implement**

```ts
  /**
   * The PDF point currently at the centre of the viewport.
   *
   * This is the transferable form of a scroll position: an offset is in this viewer's
   * pixels, relative to its own content size, and means nothing on another screen.
   */
  centerForScrollOffset(offset: { x: number; y: number },
                        viewport: { width: number; height: number }): PdfPoint {
    return this.toPdf({ x: offset.x + viewport.width / 2, y: offset.y + viewport.height / 2 });
  }

  /**
   * Where to scroll so `center` sits in the middle of the viewport.
   *
   * Clamped to the scrollable range, so a centre near a page edge produces a valid
   * offset on a differently shaped screen rather than one outside the content. A
   * viewport larger than the page scrolls to 0 and the app centres it.
   */
  scrollOffsetCentering(center: PdfPoint,
                        viewport: { width: number; height: number }): { x: number; y: number } {
    const view = this.toView(center);
    const content = this.viewSize;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, Math.max(0, max)));
    return {
      x: clamp(view.x - viewport.width / 2, content.width - viewport.width),
      y: clamp(view.y - viewport.height / 2, content.height - viewport.height),
    };
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Prove the test would catch a wrong formula**

Change `viewport.width / 2` to `viewport.width` in `centerForScrollOffset` and re-run.
Expected: FAIL. **A round-trip test passes trivially if both directions share the same
mistake** — inverting each other is not the same as being correct. Revert.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/test/scroll-roundtrip.test.ts
git commit -m "Convert between scroll offset and document centre"
```

---

## Task 3: View state (web)

**Files:**
- Create: `web/src/view/state.ts`
- Test: `web/test/view-state.test.ts`

**Interfaces:**
- Consumes: `PdfZoom` (Task 1)
- Produces: `PdfPageLayout`, `PdfTool`, `PdfSelection`, `PdfViewState`,
  `PdfViewChange`, `PdfViewEvent`

- [ ] **Step 1: Write the failing test**

```ts
test('the current page is the one containing the centre', () => {
  // In continuous layout the viewport straddles pages; defining the current page by
  // the centre keeps it independent of how much of a neighbour is visible.
  assert.equal(currentPage([{ height: 792 }, { height: 792 }], 900, 4), 1);
  assert.equal(currentPage([{ height: 792 }, { height: 792 }], 100, 4), 0);
});

test('state is round-trippable through JSON', () => {
  const state: PdfViewState = {
    pageIndex: 3, center: { x: 306, y: 400 },
    zoom: { scale: 1.5, mode: 'free' }, rotation: 90, layout: 'continuous',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL, module not found

- [ ] **Step 3: Implement**

```ts
import type { PdfPoint, PdfRect, PdfPageRotation } from '../types.js';
import type { PdfZoom } from './zoom.js';

export type PdfPageLayout = 'single' | 'continuous';

/** What a drag on the page does. Lives here so peers can agree on it. */
export type PdfTool = 'select' | 'ink' | 'note' | 'highlight' | 'redact';

export type PdfSelection =
  | { readonly kind: 'region'; readonly page: number; readonly rect: PdfRect }
  | { readonly kind: 'annotation'; readonly page: number; readonly index: number };

export interface PdfViewState {
  readonly pageIndex: number;
  /** In PDF coordinates on `pageIndex`: the point at the centre of the viewport. */
  readonly center: PdfPoint;
  readonly zoom: PdfZoom;
  readonly rotation: PdfPageRotation;
  readonly layout: PdfPageLayout;
}

export type PdfViewChange =
  | { readonly kind: 'viewport'; readonly state: PdfViewState }
  | { readonly kind: 'selection'; readonly selection: PdfSelection | null }
  | { readonly kind: 'tool'; readonly tool: PdfTool };
  // 'edit' arrives with phases 3-4, in its own plan.

export interface PdfViewEvent {
  /** Per sender. A peer ignores anything at or below the highest it has seen. */
  readonly sequence: number;
  readonly sessionId: string;
  /** Applying a remote event must emit nothing, or two viewers echo forever. */
  readonly origin: 'local' | 'remote';
  readonly change: PdfViewChange;
}

/**
 * Which page the centre falls on, walking the stack of page heights.
 *
 * `gap` is the spacing the app draws between pages; it counts, or the answer drifts by
 * one page part-way down a long document.
 */
export function currentPage(pages: readonly { height: number }[], centerY: number, gap: number): number {
  let y = 0;
  for (let i = 0; i < pages.length; i++) {
    y += pages[i]!.height + gap;
    if (centerY < y) return i;
  }
  return Math.max(0, pages.length - 1);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/view/state.ts web/test/view-state.test.ts
git commit -m "Add the view state model"
```

---

## Task 4: The viewer, viewing only (web)

**Files:**
- Create: `web/src/view/viewer.ts`
- Test: `web/test/viewer.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3, `PdfDocument`
- Produces: `PdfViewer` with `setViewport`, `scrollTo`, `scrollBy`, `goToPage`,
  `zoomTo`, `zoomIn`, `zoomOut`, `fitWidth`, `fitPage`, `setRotation`, `setLayout`,
  `render`, `transform`, `scrollOffset`, `events`, `apply`

- [ ] **Step 1: Write the failing test**

```ts
test('every change emits exactly one event', async () => {
  const viewer = await PdfViewer.open(document, { width: 390, height: 700 });
  const seen: PdfViewEvent[] = [];
  viewer.on((e) => seen.push(e));

  await viewer.zoomIn();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.change.kind, 'viewport');
  assert.equal(seen[0]!.origin, 'local');
});

test('applying a remote event emits nothing', async () => {
  // Without this two synced viewers echo each other forever.
  const viewer = await PdfViewer.open(document, { width: 390, height: 700 });
  const seen: PdfViewEvent[] = [];
  viewer.on((e) => seen.push(e));

  await viewer.apply({
    sequence: 1, sessionId: 'them', origin: 'remote',
    change: { kind: 'viewport', state: { ...(await viewer.state()), pageIndex: 0, zoom: { scale: 2, mode: 'free' } } },
  });

  assert.deepEqual(seen, []);
  assert.equal((await viewer.state()).zoom.scale, 2);
});

test('an out-of-order event does not rewind the view', async () => {
  const viewer = await PdfViewer.open(document, { width: 390, height: 700 });
  await viewer.apply(remote(5, { scale: 2, mode: 'free' }));
  await viewer.apply(remote(3, { scale: 4, mode: 'free' }));
  assert.equal((await viewer.state()).zoom.scale, 2, 'sequence 3 arrived late and must be ignored');
});

test('a peer on another screen lands on the same content', async () => {
  // The whole point. Same document, different viewports.
  const phone = await PdfViewer.open(document, { width: 390, height: 700 });
  const desktop = await PdfViewer.open(document, { width: 1200, height: 800 });

  await phone.zoomTo({ scale: 2, mode: 'free' });
  await phone.scrollTo({ x: 306, y: 400 }, 0);
  await desktop.apply({ sequence: 1, sessionId: 'phone', origin: 'remote',
                        change: { kind: 'viewport', state: await phone.state() } });

  const t = await desktop.transform();
  const centre = t.centerForScrollOffset(await desktop.scrollOffset(), { width: 1200, height: 800 });
  assert.ok(Math.abs(centre.x - 306) < 1, `centre x ${centre.x}`);
  assert.ok(Math.abs(centre.y - 400) < 1, `centre y ${centre.y}`);
});

test('fit-width is re-derived on the receiver, not adopted literally', async () => {
  const phone = await PdfViewer.open(document, { width: 390, height: 700 });
  const desktop = await PdfViewer.open(document, { width: 1200, height: 800 });
  await phone.fitWidth();
  await desktop.apply({ sequence: 1, sessionId: 'phone', origin: 'remote',
                        change: { kind: 'viewport', state: await phone.state() } });

  const zoom = (await desktop.state()).zoom;
  assert.equal(zoom.mode, 'fitWidth');
  assert.ok(zoom.scale > (await phone.state()).zoom.scale,
            'the desktop fits its own wider window, not the phone\'s scale');
});

test('resizing re-derives a fit but leaves a free zoom alone', async () => {
  const viewer = await PdfViewer.open(document, { width: 390, height: 700 });
  await viewer.fitWidth();
  const before = (await viewer.state()).zoom.scale;
  await viewer.setViewport({ width: 780, height: 700 });
  assert.ok((await viewer.state()).zoom.scale > before);

  await viewer.zoomTo({ scale: 1.5, mode: 'free' });
  await viewer.setViewport({ width: 390, height: 700 });
  assert.equal((await viewer.state()).zoom.scale, 1.5, 'a deliberate zoom survives a resize');
});

test('viewport events coalesce and edits do not', async () => {
  const viewer = await PdfViewer.open(document, { width: 390, height: 700 }, { throttleMs: 50 });
  const seen: PdfViewEvent[] = [];
  viewer.on((e) => seen.push(e));
  for (let i = 0; i < 100; i++) await viewer.scrollBy({ x: 1, y: 1 });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(seen.length < 10, `expected coalescing, got ${seen.length} events`);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL, `PdfViewer` is not exported

- [ ] **Step 3: Implement**

The viewer holds `state`, `selection`, `tool`, a `viewport`, a per-session `sequence`
counter, and the highest sequence seen per remote session. Rules that the tests above
pin, and that the implementation exists to satisfy:

- Every mutating method updates state then emits one `local` event.
- `apply` updates state and emits nothing.
- `apply` ignores an event whose `sequence` is at or below the highest already seen from
  that `sessionId`.
- Applying a `fitWidth`/`fitPage` zoom re-derives the scale from *this* viewer's
  viewport; a `free` zoom is adopted verbatim.
- `setViewport` re-derives a fit zoom and leaves a free one alone.
- Viewport events go through a throttle that keeps only the most recent; edits (Task 6,
  a later plan) bypass it.

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/view/viewer.ts web/test/viewer.test.ts
git commit -m "Add the headless viewer"
```

---

## Task 5: The wire format

**Files:**
- Create: `web/src/view/codec.ts`
- Create: `conformance/view-state.json` — the shared fixture
- Test: `web/test/view-codec.test.ts`

**Interfaces:**
- Produces: `encodeEvent()`, `decodeEvent()`, `WIRE_VERSION`

- [ ] **Step 1: Write the failing test**

```ts
test('an unknown version is refused rather than misread', () => {
  assert.throws(() => decodeEvent(JSON.stringify({ v: 999, ... })), /version/);
});

test('the shared fixture decodes to the documented state', () => {
  // conformance/view-state.json is the one artefact all three platforms agree on.
  const fixture = JSON.parse(readFileSync(`${CONFORMANCE}view-state.json`, 'utf8'));
  for (const c of fixture.cases) {
    const decoded = decodeEvent(JSON.stringify(c.wire));
    assert.equal(decoded.change.state.pageIndex, c.expect.pageIndex);
    assert.ok(Math.abs(decoded.change.state.zoom.scale - c.expect.zoom.scale) < 1e-6);
  }
});

test('a float scale survives the round trip within single precision', () => {
  // Android holds scale as Float. The fixture must not encode values that only
  // Double can represent, or the platforms will disagree on decode.
  const encoded = encodeEvent(event({ scale: 1 / 3, mode: 'free' }));
  const back = decodeEvent(encoded);
  assert.ok(Math.abs(back.change.state.zoom.scale - 1 / 3) < 1e-6);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL

- [ ] **Step 3: Implement the codec and write the fixture**

`WIRE_VERSION = 1`, a `v` field on every envelope, and a decoder that throws on anything
else so an older peer refuses rather than misreads. Field names are the property names.

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/view/codec.ts conformance/view-state.json web/test/view-codec.test.ts
git commit -m "Add the view event wire format"
```

---

## Task 6: Port to iOS

**Files:**
- Modify: `ios/Sources/PDFCora/Geometry.swift` — the two transform functions
- Create: `ios/Sources/PDFCora/View/{Zoom,ViewState,Viewer,Codec}.swift`
- Test: `ios/Tests/PDFCoraTests/ViewerTests.swift`

- [ ] **Step 1: Port the tests first, one for one**

Every test from Tasks 1–5, same assertions. If a Swift test needs different assertions
than its TypeScript twin, the implementations have diverged and one is wrong.

- [ ] **Step 2: Implement**

`PdfViewer` is an `actor`, because `PdfDocument` is one. **It must never hold its own
executor while awaiting the document's** — that is the deadlock this shape invites.
Events are an `AsyncStream` exposed `nonisolated`.

- [ ] **Step 3: Run the tests**

Run: `./scripts/test-ios.sh`
Expected: PASS

- [ ] **Step 4: Commit**

---

## Task 7: Port to Android

**Files:**
- Modify: `android/pdfcora/src/main/java/com/pdfcora/Types.kt`
- Create: `android/pdfcora/src/main/java/com/pdfcora/view/{Zoom,ViewState,Viewer,Codec}.kt`
- Test: `android/pdfcora/src/androidTest/java/com/pdfcora/ViewerTest.kt`

- [ ] **Step 1: Port the tests first, one for one**

- [ ] **Step 2: Implement**

Events are a `Flow<PdfViewEvent>`. **`scale` is `Float` here and `Double` elsewhere**, so
the codec tests must assert to single precision, not exact equality — the one place the
three platforms genuinely differ.

- [ ] **Step 3: Run the tests**

Run: `./scripts/test-android.sh`
Expected: PASS

- [ ] **Step 4: Commit**

---

## Task 8: The cross-platform contract

The claim this whole plan exists to support, asserted the way redaction and signatures
are — against a shared fixture, not against ourselves.

**Files:**
- Modify: `web/test/conformance.test.ts`, `ios/Tests/PDFCoraTests/ConformanceTests.swift`,
  `android/pdfcora/src/androidTest/java/com/pdfcora/ConformanceTest.kt`

- [ ] **Step 1: Write the contract, identically on all three**

```
Given conformance/view-state.json, for each case:
  decode the wire event
  build a transform for the case's page size and the case's *receiving* viewport
  derive the scroll offset
  assert it equals the case's expected offset within half a pixel
```

The fixture carries a phone case and a desktop case for the same state, so the test
proves the two land on the same content rather than the same numbers.

- [ ] **Step 2: Run all three**

Run: `cd web && npm test`, `./scripts/test-ios.sh`, `./scripts/test-android.sh`
Expected: PASS on all three

- [ ] **Step 3: Prove the contract has teeth**

Change the web `scrollOffsetCentering` to drop the clamp, and confirm the contract fails
on at least one case. **A conformance test that passes with the implementation broken is
not a contract.** Revert.

- [ ] **Step 4: Commit**

---

## Stated limitations

- **No editing yet.** Selection, tools and the edit events are phases 3–4 and get their
  own plan. The viewer here can be driven and observed, but changes nothing in the
  document.
- **Different aspect ratios cannot show the same rectangle.** Only the centre and the
  zoom mode are synced; a tall phone and a wide desktop will differ at the edges. That is
  a property of screens, not a defect.
- **Nothing here does networking.** Events are values; moving them is the app's job.

## Risks

| Risk | Mitigation |
| --- | --- |
| The round-trip test passes because both directions share a mistake | Task 2 Step 5 breaks one direction deliberately and requires the test to fail |
| The conformance fixture is generated from our own encoder, so it proves only self-consistency | It carries hand-written expected scroll offsets for two differently shaped viewports, computed independently in the spec |
| Actor-on-actor deadlock between viewer and document | Named in Task 6; a concurrency test hammering both, mirroring `concurrentAccessToOneDocumentIsSafe` |
| Float vs Double disagreement on decode | Codec tests assert to single precision; the fixture avoids values only Double can hold |
| The viewer becomes a second API surface that drifts | No editing in this plan at all; when it arrives it delegates, gated by a byte-identity test |

## Self-review notes

- Every task ends with a test that fails if the task is reverted.
- Two tasks (2 and 8) deliberately break the implementation to prove the gate catches it
  — the same discipline the DER fuzz gate and the redaction erasure assertion needed,
  both of which passed with their checks deleted.
- No task adds a view type, and no task does networking.
