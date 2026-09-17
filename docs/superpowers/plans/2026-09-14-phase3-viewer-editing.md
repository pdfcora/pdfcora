# Viewer Editing and Sync Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Editing through the viewer, so a change made on one screen reaches another —
and so the UI layer has something to drive when the demos adopt it. Phases 3–4 of the
spec: edit methods that delegate, edit events that carry enough to replay, the document
fingerprint, and the presenter-only rule.

**Architecture:** The viewer delegates every edit to the existing `PdfPage`/`PdfDocument`
API and then emits. Two code paths producing annotations would drift, and the bug would
only appear through one of them. TypeScript first, then ported.

**Tech Stack:** TypeScript/Node, Swift, Kotlin.

**Spec:** `docs/superpowers/specs/2026-09-14-viewer-and-sync-design.md` §§4.5, 5, 8, 9

## What was verified before writing this

| Claim | Result |
| --- | --- |
| The edit surface to delegate to already exists | ✅ `addNote(rect:contents:color:)`, `addInk(strokes:color:lineWidth:)`, `addHighlight(quads:color:)`, `removeAnnotation(at:)`, `setText(_:forFieldAt:)`, `setChecked(_:forFieldAt:)`, `setOption(_:selected:forFieldAt:)` |
| Redaction is available through the document | ✅ `PdfDocument.redact(_:)` returning a report, on all three platforms |
| The viewer already emits and applies viewport, selection and tool changes | ✅ phases 1–2, 220/20/21 tests |
| Annotation indices are positions in a specific document | ✅ `removeAnnotation(at:)` takes an index, so replaying it against different bytes removes the wrong thing — hence the fingerprint in Task 3 |
| `addInk` means the same thing everywhere | ❌ **no** — iOS takes `strokes: [[PdfPoint]]` and makes *one* annotation of many strokes; web and Android take a single `stroke` and would make *one annotation per stroke*. Not equivalent, so the wire carries one stroke — see Limitations |
| A full save is required after redaction | ✅ pinned by existing tests: an incremental save leaves the original content stream |

## Global Constraints

- **The viewer delegates, never reimplements.** Gated in Task 5 by a test asserting the
  same edit through both routes produces byte-identical saved documents.
- **An edit event carries its arguments.** "Annotation 3 was added" cannot be replayed —
  it does not say what to add.
- **Edits never coalesce.** Viewport changes may be dropped in favour of a later one; an
  annotation added is not superseded by the next.
- **Applying a remote edit emits nothing**, exactly as for viewport changes.
- **A mismatched document is refused, not applied.** Indices are meaningless across
  different bytes.

---

## Task 1: The edit event (web)

**Files:**
- Modify: `web/src/view/state.ts`
- Test: `web/test/view-edit.test.ts`

**Interfaces:**
- Produces: `PdfEdit`, and `PdfViewChange` gains `{ kind: 'edit'; edit: PdfEdit }`

- [ ] **Step 1: Write the failing test**

```ts
test('an edit carries enough to replay it', () => {
  // The point of the type: a peer must be able to perform the same call.
  const edit: PdfEdit = {
    kind: 'noteAdded', page: 0,
    rect: { left: 1, bottom: 2, right: 3, top: 4 },
    contents: 'hello', color: { red: 255, green: 235, blue: 59 },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(edit)), edit);
});

test('every edit kind round-trips through the codec', () => {
  for (const edit of everyEditKind()) {
    const event = { sequence: 1, sessionId: 'a', origin: 'local' as const,
                    change: { kind: 'edit' as const, edit } };
    assert.deepEqual(decodeEvent(encodeEvent(event)), event);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web && npm test`
Expected: FAIL, `PdfEdit` is not exported

- [ ] **Step 3: Implement**

```ts
/**
 * A change to the document, carrying the arguments of the call that made it.
 *
 * An event saying only "annotation 3 was added" cannot be reproduced by a peer — it does
 * not say what to add — so each case mirrors the parameters of the API it came from.
 */
export type PdfEdit =
  | { readonly kind: 'noteAdded'; readonly page: number; readonly rect: PdfRect;
      readonly contents: string; readonly color: PdfColor }
  | { readonly kind: 'inkAdded'; readonly page: number; readonly stroke: readonly PdfPoint[];
      readonly color: PdfColor; readonly lineWidth: number }
  | { readonly kind: 'highlightAdded'; readonly page: number; readonly quads: readonly PdfQuad[];
      readonly color: PdfColor }
  | { readonly kind: 'annotationRemoved'; readonly page: number; readonly index: number }
  | { readonly kind: 'fieldTextSet'; readonly page: number; readonly annotationIndex: number;
      readonly value: string }
  | { readonly kind: 'fieldCheckedSet'; readonly page: number; readonly annotationIndex: number;
      readonly checked: boolean }
  | { readonly kind: 'fieldOptionSet'; readonly page: number; readonly annotationIndex: number;
      readonly option: number; readonly selected: boolean }
  | { readonly kind: 'redacted'; readonly targets: readonly PdfRedactionTarget[] };
```

- [ ] **Step 4: Run the tests** — Expected: PASS
- [ ] **Step 5: Commit**

---

## Task 2: Editing through the viewer (web)

**Files:**
- Modify: `web/src/view/viewer.ts`
- Test: `web/test/viewer-editing.test.ts`

**Interfaces:**
- Produces: `addNote`, `addInk`, `addHighlight`, `removeAnnotation`, `setFieldText`,
  `setFieldChecked`, `setFieldOption`, `redact` on `PdfViewer`

- [ ] **Step 1: Write the failing test**

```ts
test('an edit emits immediately and is not coalesced away', async () => {
  // Viewport changes may be dropped in favour of a later one. An annotation added is
  // not superseded by the next, and dropping it loses data.
  const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 1000 });
  const seen: PdfViewEvent[] = [];
  viewer.on((e) => seen.push(e));

  await viewer.addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'one');
  await viewer.addNote({ left: 40, bottom: 10, right: 60, top: 30 }, 'two');

  assert.equal(seen.length, 2, 'both edits, immediately, despite a 1s viewport throttle');
  assert.deepEqual(seen.map((e) => e.change.kind), ['edit', 'edit']);
});

test('an edit through the viewer reaches the document', async () => {
  const viewer = await PdfViewer.open(doc, PHONE, { throttleMs: 0 });
  const before = (await (await doc.page(0)).annotations()).length;
  await viewer.addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'hello');
  assert.equal((await (await doc.page(0)).annotations()).length, before + 1);
});

test('redaction through the viewer removes content from the saved bytes', async () => {
  // The claim redaction exists for. Asserted on the bytes, never the text layer.
  const document = await PdfDocument.open(bytes());
  const viewer = await PdfViewer.open(document, PHONE, { throttleMs: 0 });
  const objects = await (await document.page(0)).objects();
  const target = objects.find((o) => o.text?.includes('Goodbye'))!;

  await viewer.redact([{ kind: 'region', rect: target.bounds, pageIndex: 0 }]);
  const saved = await document.toBytes('full');
  assert.ok(!Buffer.from(saved).toString('latin1').includes('Goodbye'));
});
```

- [ ] **Step 2: Run it and watch it fail** — Expected: FAIL, `addNote` is not a function

- [ ] **Step 3: Implement**

Each method calls the existing page API and then emits the matching `PdfEdit`. Edits go
straight to `emit`, bypassing the viewport throttle.

- [ ] **Step 4: Run the tests** — Expected: PASS
- [ ] **Step 5: Commit**

---

## Task 3: The fingerprint, and replaying an edit (web)

**Files:**
- Modify: `web/src/view/viewer.ts`
- Test: `web/test/viewer-sync-edits.test.ts`

**Interfaces:**
- Produces: `PdfViewer.documentFingerprint`, `apply` handling `edit`

- [ ] **Step 1: Write the failing test**

```ts
test('an applied edit reproduces the change on the peer', async () => {
  const a = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
  const b = await PdfViewer.open(await PdfDocument.open(bytes()), DESKTOP, { throttleMs: 0 });
  const seen: PdfViewEvent[] = [];
  b.on((e) => seen.push(e));

  const events: PdfViewEvent[] = [];
  a.on((e) => events.push(e));
  await a.addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'hello');

  await b.apply({ ...events[0]!, origin: 'remote' });
  assert.deepEqual(seen, [], 'applying must not echo');
  assert.equal((await (await b.document.page(0)).annotations()).length, 1);
});

test('an event from a different document is refused, not applied', async () => {
  // Indices are positions in specific bytes. Replaying annotationRemoved(3) against
  // other bytes removes the wrong thing, silently.
  const a = await PdfViewer.open(await PdfDocument.open(bytes()), PHONE, { throttleMs: 0 });
  const b = await PdfViewer.open(await PdfDocument.open(otherBytes()), PHONE, { throttleMs: 0 });
  assert.notEqual(a.documentFingerprint, b.documentFingerprint);

  await assert.rejects(
    () => b.apply({ sequence: 1, sessionId: 'a', origin: 'remote',
                    documentFingerprint: a.documentFingerprint,
                    change: { kind: 'edit', edit: { kind: 'annotationRemoved', page: 0, index: 0 } } }),
    /document/);
});

test('a viewport event is accepted across different documents', async () => {
  // Only edits depend on the bytes. Two people looking at different documents can still
  // be told where the other is looking, and refusing that would be over-strict.
});
```

- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement**

The fingerprint is a hash of the opened bytes, computed once. `apply` refuses an `edit`
whose fingerprint differs, and ignores the field for viewport, selection and tool.

- [ ] **Step 4: Run the tests** — Expected: PASS
- [ ] **Step 5: Commit**

---

## Task 4: The presenter rule (web)

**Files:**
- Modify: `web/src/view/viewer.ts`
- Test: `web/test/viewer-presenter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('a follower cannot edit', async () => {
  const viewer = await PdfViewer.open(doc, PHONE, { role: 'follower' });
  await assert.rejects(() => viewer.addNote(rect, 'nope'), /follower/);
});

test('a follower may still scroll and zoom its own view', async () => {
  // Following is not the same as being frozen: a follower reading a different part of
  // the page is a normal thing to do.
  const viewer = await PdfViewer.open(doc, PHONE, { role: 'follower' });
  viewer.zoomIn();
  assert.ok(viewer.state.zoom.scale > 0);
});

test('an edit from a session that is not the presenter is ignored', async () => {
  const viewer = await PdfViewer.open(doc, PHONE, { role: 'follower', presenterId: 'boss' });
  await viewer.apply({ sequence: 1, sessionId: 'someone-else', origin: 'remote',
                       documentFingerprint: viewer.documentFingerprint,
                       change: { kind: 'edit', edit: { kind: 'annotationRemoved', page: 0, index: 0 } } });
  assert.equal((await (await doc.page(0)).annotations()).length, 0, 'nothing was removed');
});
```

- [ ] **Step 2: Run it and watch it fail**
- [ ] **Step 3: Implement**

`role: 'presenter' | 'follower'` defaulting to presenter, and an optional `presenterId`.
Local edits throw for a follower; applied edits are accepted only from `presenterId` when
one is set.

- [ ] **Step 4: Run the tests** — Expected: PASS
- [ ] **Step 5: Commit**

---

## Task 5: The delegation gate (web)

The constraint that keeps the viewer from becoming a second, divergent API.

**Files:**
- Test: `web/test/viewer-delegation.test.ts`

- [ ] **Step 1: Write the test**

```ts
test('the same edit through the viewer and the page produces identical bytes', async () => {
  // If these ever differ, the viewer has grown its own implementation and the two will
  // drift — with bugs that appear through only one of them.
  const viaPage = await PdfDocument.open(bytes());
  await (await viaPage.page(0)).addNote(rect, 'hello', { red: 255, green: 235, blue: 59 });

  const viaViewer = await PdfDocument.open(bytes());
  const viewer = await PdfViewer.open(viaViewer, PHONE, { throttleMs: 0 });
  await viewer.addNote(rect, 'hello', { red: 255, green: 235, blue: 59 });

  assert.deepEqual(await viaPage.toBytes('full'), await viaViewer.toBytes('full'));
});
```

Repeat for ink, highlight, removal and each field setter.

- [ ] **Step 2: Run it** — Expected: PASS, since the viewer delegates
- [ ] **Step 3: Prove it has teeth**

Make `viewer.addNote` add the note twice and confirm the test fails. **A gate that has
never failed is not known to work.** Revert.

- [ ] **Step 4: Commit**

---

## Task 6: Port to iOS and Android

**Files:**
- Modify: `ios/Sources/PDFCora/View/{ViewState,Viewer,Codec}.swift`
- Modify: `android/pdfcora/src/main/java/com/pdfcora/view/{ViewState,Viewer,Codec}.kt`
- Test: the iOS and Android suites gain the same tests

- [ ] **Step 1: Port the tests first, one for one**
- [ ] **Step 2: Implement**
- [ ] **Step 3: Run both gates**

Run: `./scripts/test-ios.sh` and `ANDROID_SERIAL=<emulator> ./scripts/test-android.sh`
Expected: PASS. **Give the emulator 4GB** — at 2GB the suite is killed part way and
blames whichever test was in flight.

- [ ] **Step 4: Commit**

---

## Task 7: Extend the shared fixture

**Files:**
- Modify: `conformance/view-state.json`, and the three conformance tests

- [ ] **Step 1: Add an edit case per kind**

Computed independently, as the existing cases were. Each carries the encoded event and
the arguments a peer must end up calling with.

- [ ] **Step 2: Run all three**
- [ ] **Step 3: Prove it has teeth** — drop a field from one platform's encoder and
  confirm the contract fails there. Revert.
- [ ] **Step 4: Commit**

---

## Stated limitations

- **Presenter-only.** Two people editing the same annotation is a distributed-systems
  problem; last-writer-wins silently discards work and doing it properly means a CRDT.
  Out of scope, and said plainly rather than left to be discovered.
- **Replay assumes identical bytes.** The fingerprint turns a silent corruption into a
  refusal, but it cannot merge divergent documents.
- **Ink syncs one stroke at a time.** iOS's `addInk` builds a single annotation from
  many strokes; web's and Android's build one annotation from one stroke. Those are not
  the same document, so the wire carries a single stroke and a multi-stroke iOS
  annotation cannot be replayed faithfully. Aligning the three signatures is a separate
  change to the core API and is not smuggled into this plan.
- **No UI.** That is phase 5.

## Risks

| Risk | Mitigation |
| --- | --- |
| The viewer grows its own edit implementation | Task 5's byte-identity gate, broken deliberately to prove it fires |
| An edit replays against shifted indices | The fingerprint refuses different bytes; within one document, edits are ordered by sequence |
| Redaction replayed by a follower does not use a full save | The edit event records the targets; the peer's `redact` path is the same one, which already requires a full save and is pinned by existing tests |
| Edits get coalesced along with viewport changes | Separate paths, asserted by a test with a one-second viewport throttle |

## Self-review notes

- Every task ends with a test that fails if the task is reverted.
- Tasks 5 and 7 deliberately break the implementation to prove the gate catches it.
- No task adds a view type; the UI layer is phase 5 and has its own plan.
