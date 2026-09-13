# Redaction Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove content from a document so it cannot be recovered — from the page, the
text layer, annotations, form values, metadata, attachments and thumbnails.

**Architecture:** PDFium removes page objects and regenerates the content stream; the
`PdfWriter` and `PdfReader` built in phase 4 handle what PDFium cannot write. Built in
TypeScript first, then ported.

**Tech Stack:** TypeScript/Node, Swift, Kotlin, PDFium `chromium/7243`.

**Spec:** `docs/superpowers/specs/2026-09-13-signatures-and-redaction-design.md` §8

## What was verified before writing this

Every mechanism below was probed against the real engine, not assumed:

| Claim | Result |
| --- | --- |
| `FPDFPage_RemoveObject` + `GenerateContent` + save removes text | ✅ extracted text went from `"Hello, world!\r\nGoodbye, world!"` to `"Hello, world!"` |
| …and removes it from the **file bytes** | ✅ a raw scan for `Goodbye` in the saved output returned false |
| Per-character boxes are available for split decisions | ✅ `FPDFText_GetCharBox` gives `'H' l=20.2 r=28.4 b=50.0 t=57.9` and so on |
| A text object's string can be rewritten in place | ✅ `FPDFText_SetText` accepted |
| The original font survives a rewrite | ✅ `FPDFTextObj_GetFont` → Helvetica, size 16 |

That last row matters: a split that loses the font would visibly reflow the page.

## Global Constraints

- **Redaction that only draws a black box is a security bug, not a feature.** Every task
  is measured by whether the content is gone from the saved bytes, never by appearance.
- Saving uses `.full`. An incremental save leaves the original content stream in the
  file, which defeats the entire exercise.
- Characters are dropped on **intersection**, not containment: a character half inside
  the region is still legible and still in the text layer.
- What is not removed is named in the report, never left implied.

---

## Task 1: A page object model (web)

Reading what is on a page, so a region can be resolved to objects.

**Files:**
- Create: `web/src/pageObjects.ts`
- Test: `web/test/page-objects.test.ts`

**Interfaces:**
- Produces: `PdfPage.objects(): Promise<PdfPageObject[]>` where
  `PdfPageObject = { index: number; kind: 'text'|'path'|'image'|'shading'|'form';
  bounds: PdfRect; text?: string; fontSize?: number }`

- [ ] **Step 1: Write the failing test**

```ts
test('lists the objects on a page with their bounds', async () => {
  const page = await (await PdfDocument.open(read('hello_world.pdf'))).page(0);
  const objects = await page.objects();

  assert.equal(objects.length, 2, 'hello_world.pdf has two text objects');
  assert.ok(objects.every((o) => o.kind === 'text'));
  // Probed values: the second object sits above the first.
  assert.ok(Math.abs(objects[0]!.bounds.left - 20.2) < 0.5);
  assert.ok(objects[1]!.bounds.bottom > objects[0]!.bounds.bottom);
});

test('reads the text an object carries', async () => {
  const page = await (await PdfDocument.open(read('hello_world.pdf'))).page(0);
  const objects = await page.objects();
  assert.equal(objects[1]!.text, 'Goodbye, world!');
});

test('a page with images reports them as images', async () => {
  const page = await (await PdfDocument.open(read('annotation_stamp_with_ap.pdf'))).page(0);
  const kinds = new Set((await page.objects()).map((o) => o.kind));
  assert.ok(kinds.size > 0);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement**, binding `FPDFPage_CountObjects`, `GetObject`,
      `FPDFPageObj_GetType`, `GetBounds`, `FPDFTextObj_GetText` and `GetFontSize`.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 2: Removing whole objects (web)

**Files:**
- Create: `web/src/redact/region.ts`
- Test: `web/test/redact-region.test.ts`

**Interfaces:**
- Produces: `PdfDocument.redact(targets: PdfRedactionTarget[]): Promise<PdfRedactionReport>`,
  with `PdfRedactionTarget = { kind: 'region'; rect: PdfRect; pageIndex: number }`

- [ ] **Step 1: Write the failing test** — the assertion that defines the feature:

```ts
/**
 * The only assertion that matters. Extraction alone is not enough: a black box drawn
 * over text leaves the text in the file, which is the classic redaction failure.
 */
test('redacted text is gone from the extracted text AND the file bytes', async () => {
  const base = read('hello_world.pdf');
  const document = await PdfDocument.open(base);
  const objects = await (await document.page(0)).objects();
  const goodbye = objects.find((o) => o.text?.includes('Goodbye'))!;

  await document.redact([{ kind: 'region', rect: goodbye.bounds, pageIndex: 0 }]);
  const saved = await document.toBytes('full');

  const reopened = await PdfDocument.open(saved);
  const text = await (await reopened.page(0)).text.string();
  assert.ok(!text.includes('Goodbye'), `still extractable: ${JSON.stringify(text)}`);

  const raw = new TextDecoder('latin1').decode(saved);
  assert.ok(!raw.includes('Goodbye'), 'the text is still in the file bytes');

  // And the content that was not redacted must survive.
  assert.ok(text.includes('Hello'));
});

test('the report says what was removed', async () => {
  const report = await redactGoodbye();
  assert.equal(report.textObjects, 1);
  assert.deepEqual(report.pages, [0]);
});

test('an object outside the region is untouched', async () => {
  const base = read('hello_world.pdf');
  const document = await PdfDocument.open(base);
  // A region in an empty corner.
  await document.redact([{ kind: 'region', rect: { left: 0, bottom: 0, right: 5, top: 5 }, pageIndex: 0 }]);
  const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0)).text.string();
  assert.ok(text.includes('Hello') && text.includes('Goodbye'));
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement** whole-object removal: intersect bounds, `FPDFPage_RemoveObject`,
      `FPDFPageObj_Destroy`, `FPDFPage_GenerateContent`.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Mutation-test the erasure assertion** — make `redact` a no-op and confirm
      the test fails on both the extraction and the raw-byte check. An erasure test that
      cannot fail is worse than none.
- [ ] **Step 6: Checkpoint.**

---

## Task 3: Splitting a partially covered text run (web)

The hardest piece in the design. A region covering half a word must remove exactly those
characters and leave the rest legible and correctly positioned.

**Files:**
- Create: `web/src/redact/split.ts`
- Test: `web/test/redact-split.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/** "Goodbye, world!" with a region over "Goodbye" only. */
test('a region over part of a run removes only those characters', async () => {
  const document = await PdfDocument.open(read('hello_world.pdf'));
  const page = await document.page(0);
  const run = (await page.objects()).find((o) => o.text === 'Goodbye, world!')!;

  // Probed: 'G' starts at l=20.2. Cover the first word only.
  const region = { ...run.bounds, right: run.bounds.left + 60 };
  await document.redact([{ kind: 'region', rect: region, pageIndex: 0 }]);

  const saved = await document.toBytes('full');
  const text = await (await (await PdfDocument.open(saved)).page(0)).text.string();

  assert.ok(!text.includes('Goodbye'), 'the covered word must be gone');
  assert.ok(text.includes('world'), 'the rest of the run must survive');
  assert.ok(!new TextDecoder('latin1').decode(saved).includes('Goodbye'));
});

/** A character half inside the region is still legible, so it goes. */
test('characters are dropped on intersection, not containment', async () => {
  const document = await PdfDocument.open(read('hello_world.pdf'));
  const page = await document.page(0);
  const run = (await page.objects()).find((o) => o.text === 'Goodbye, world!')!;

  // Probed: 'H' spans l=20.2 r=28.4. Cover only its left half.
  const region = { ...run.bounds, right: 24 };
  await document.redact([{ kind: 'region', rect: region, pageIndex: 0 }]);

  const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0)).text.string();
  assert.ok(!text.startsWith('G'), 'a half-covered character must still be removed');
});

test('the surviving text keeps its font and size', async () => {
  const document = await PdfDocument.open(read('hello_world.pdf'));
  const before = (await (await document.page(0)).objects())
    .find((o) => o.text === 'Goodbye, world!')!.fontSize;

  await redactFirstWord(document);
  const after = (await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
    .objects()).find((o) => o.text?.includes('world'))!.fontSize;

  assert.equal(after, before, 'a split that loses the font reflows the page');
});

test('the report distinguishes split runs from removed ones', async () => {
  const report = await redactFirstWord(await PdfDocument.open(read('hello_world.pdf')));
  assert.equal(report.textObjectsSplit, 1);
  assert.equal(report.textObjects, 0);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** For each intersecting text object: take per-character boxes
      from `FPDFText_GetCharBox`, partition into surviving runs, then rewrite the object
      with `FPDFText_SetText` for the first run and create additional objects with
      `FPDFPageObj_CreateTextObj` for any others, carrying the original font, size and a
      matrix translated to each run's origin.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 4: Search-driven redaction (web)

**Files:**
- Modify: `web/src/redact/region.ts`
- Test: `web/test/redact-search.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('redacting by search removes every occurrence', async () => {
  const document = await PdfDocument.open(read('find_text_consecutive.pdf'));
  const report = await document.redact([{ kind: 'textMatches', query: 'a' }]);

  const saved = await document.toBytes('full');
  const text = await (await (await PdfDocument.open(saved)).page(0)).text.string();
  assert.ok(!text.includes('a'), `still present: ${JSON.stringify(text)}`);
  assert.ok(report.pages.length > 0);
});

test('a query that matches nothing changes nothing', async () => {
  const base = read('hello_world.pdf');
  const document = await PdfDocument.open(base);
  const report = await document.redact([{ kind: 'textMatches', query: 'zzzzz' }]);

  assert.equal(report.textObjects + report.textObjectsSplit, 0);
  const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0)).text.string();
  assert.ok(text.includes('Hello') && text.includes('Goodbye'));
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement**, reusing the existing search to produce rects, then the
      region path.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 5: The full scrub (web)

Content is only half of it. A comment, a filled field or a thumbnail can carry the
removed text out of the document.

**Files:**
- Create: `web/src/redact/scrub.ts`
- Test: `web/test/redact-scrub.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('an annotation over the region is removed', async () => {
  const document = await PdfDocument.open(read('annotation_highlight_long_content.pdf'));
  const before = (await (await document.page(0)).annotations()).length;
  assert.ok(before > 0);

  const annotation = (await (await document.page(0)).annotations())[0]!;
  const report = await document.redact([{ kind: 'region', rect: annotation.rect, pageIndex: 0 }]);

  assert.ok(report.annotations > 0, 'the report must say so');
  const after = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0)).annotations();
  assert.ok(after.length < before);
});

test('a form field value in the region is cleared', async () => {
  const document = await PdfDocument.open(read('text_form.pdf'));
  const page = await document.page(0);
  const field = (await page.formFields())[0]!;
  await page.setText('SECRET', { fieldAt: field.annotationIndex });

  const report = await document.redact([{ kind: 'region', rect: field.rect, pageIndex: 0 }]);
  assert.ok(report.formFields.length > 0);

  const saved = await document.toBytes('full');
  assert.ok(!new TextDecoder('latin1').decode(saved).includes('SECRET'),
    'a filled field carries the text out of the document');
});

/** No FPDF_SetMetaText exists, so this goes through PdfWriter. */
test('metadata containing a redacted string is scrubbed', async () => {
  const document = await PdfDocument.open(read('hello_world.pdf'));
  const report = await document.redact([{ kind: 'textMatches', query: 'Goodbye' }],
    { scrubMetadata: true });

  const saved = await document.toBytes('full');
  assert.ok(!new TextDecoder('latin1').decode(saved).includes('Goodbye'));
  assert.ok(Array.isArray(report.metadataKeys));
});

/** A rendered copy of the page shows exactly what was removed. */
test('page thumbnails are removed', async () => {
  const document = await PdfDocument.open(read('annotation_stamp_with_ap.pdf'));
  const report = await document.redact([{ kind: 'region', rect: { left: 0, bottom: 0, right: 999, top: 999 }, pageIndex: 0 }]);
  assert.equal(typeof report.thumbnailsRemoved, 'number');
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Annotations and fields via PDFium; metadata, attachments and
      thumbnails via `PdfWriter`, which is why phase 4 built it.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 6: Port to iOS and Android

- [ ] **Step 1: Port the tests first**, assertion for assertion, Tasks 1-5.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Port the implementation.**
- [ ] **Step 4: Run both suites, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 7: Conformance, demos and docs

- [ ] **Step 1:** Add the erasure contract to the conformance suite — redact, save,
      re-open, and assert absence from both the text and the bytes, on all three.
- [ ] **Step 2:** Mutation-test that assertion.
- [ ] **Step 3:** Add redaction to each demo's editor: drag a region, see it removed, and
      show the report.
- [ ] **Step 4:** Document redaction in each quickstart, **including §8.4's limitation**
      in the same breath as the feature.
- [ ] **Step 5:** Run `./scripts/make-docs.sh --no-serve` and `./scripts/package-all.sh`.
- [ ] **Step 6:** Commit.

---

## Stated limitations

These go in the docs beside the feature, not in a footnote.

- **Images are removed whole, not repainted.** An image overlapping the region goes
  entirely; punching a hole means decoding, editing and re-encoding pixels, which
  changes the image's compression and is a much larger piece of work. The report records
  the removal so a caller can tell the difference.
- **Encrypted documents are refused**, as everything built on `PdfWriter` is.
- **A signed document cannot be redacted without breaking its signature.** That is
  correct behaviour — the bytes changed — and the SDK will say so rather than appear to
  do both.

## Risks

- **Silent incompleteness.** The failure mode is a document that looks redacted and is
  not. Every task's gate is a raw-byte scan, and Task 2 mutation-tests that gate.
- **Text splitting is the hardest piece.** The probe confirms every API it needs exists;
  what remains is getting run boundaries and matrices right, which the font-size test
  guards.
- **`GenerateContent` rewrites the whole content stream.** Anything PDFium does not model
  in a page object is lost in the rewrite. Task 2's sweep across the corpus — open,
  redact nothing, save, compare extracted text — is the control for that.

## Self-review notes

- `redactGoodbye` and `redactFirstWord` are test helpers to write in the files using them.
- Task 5's thumbnail test asserts only that the count is reported, because no corpus
  document is known to carry one; if none does, say so rather than let the test imply
  coverage it does not have.
