# PdfWriter and Signature Reading — Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An incremental-update writer for all three platforms, then signature reading
on top of it — phases 1 and 2 of the signatures/redaction spec.

**Architecture:** `PdfWriter` appends a valid incremental update to saved PDF bytes,
because PDFium cannot create dictionaries. It is built in TypeScript first, where the
test loop is seconds rather than minutes, then ported to Swift and Kotlin against the
same fixtures. Signature *reading* needs no writer and ships alongside.

**Tech Stack:** TypeScript/Node, Swift/XCTest, Kotlin/AndroidJUnit, PDFium `chromium/7243`.

**Spec:** `docs/superpowers/specs/2026-09-13-signatures-and-redaction-design.md`

## Global Constraints

- No new runtime dependency in any SDK. Web gains no CMS library (spec §6).
- Every public type gets the same shape and the same error cases on all three platforms.
- Comments only where the reason is not evident from the code (project rule).
- Geometry stays in PDF space; no implicit Y-flip.
- New errors: `signingFailed`, `timestampFailed`, `redactionFailed`,
  `unsupportedSignature` — added to all three `PdfError` types together.

---

## Task 1: PDF value serialisation (web)

**Files:**
- Create: `web/src/writer/values.ts`
- Test: `web/test/writer-values.test.ts`

**Interfaces:**
- Produces: `type PdfValue`, `serialize(value: PdfValue): Uint8Array`,
  `ref(n: number, gen?: number): PdfValue`, `name(s: string): PdfValue`

- [ ] **Step 1: Write the failing test**

```ts
import { serialize, name, ref } from '../dist/writer/values.js';
const text = (v: unknown) => new TextDecoder().decode(serialize(v as never));

test('dictionaries, names, refs and strings round-trip to PDF syntax', () => {
  assert.equal(text(name('Sig')), '/Sig');
  assert.equal(text(ref(12)), '12 0 R');
  assert.equal(text([1, 2, 3]), '[1 2 3]');
  assert.equal(text({ Type: name('Sig'), Contents: ref(4) }),
               '<</Type /Sig /Contents 4 0 R>>');
});

test('strings escape delimiters rather than corrupting the file', () => {
  assert.equal(text({ Reason: 'a(b)c\\d' }), '<</Reason (a\\(b\\)c\\\\d)>>');
});

test('hex strings keep their exact byte width', () => {
  // The /Contents placeholder is patched in place later; its length must not move.
  assert.equal(text(hexString(new Uint8Array(4))).length, 10);  // <00000000>
});
```

- [ ] **Step 2: Run it and confirm it fails** — `cd web && npm test` → module not found.
- [ ] **Step 3: Implement `values.ts`** — a tagged union plus a serialiser. No parsing.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint** — `npm test` fully green before moving on.

---

## Task 2: Trailer scanning (web)

Reading just enough of an existing file to append to it: where the last xref is, what
the trailer says, and the highest object number in use.

**Files:**
- Create: `web/src/writer/scan.ts`
- Test: `web/test/writer-scan.test.ts`

**Interfaces:**
- Consumes: Task 1's `PdfValue`.
- Produces: `scanTrailer(bytes: Uint8Array): TrailerInfo` where
  `TrailerInfo = { startXref: number; style: 'table' | 'stream'; size: number;
  root: PdfValue; info?: PdfValue; id?: PdfValue }`

- [ ] **Step 1: Write the failing test**

```ts
// Both xref styles must work: a file written since PDF 1.5 may use either.
for (const file of ['hello_world.pdf', 'text_form.pdf', 'annotation_highlight_long_content.pdf']) {
  test(`scans the trailer of ${file}`, () => {
    const info = scanTrailer(readFileSync(corpus(file)));
    assert.ok(info.startXref > 0 && info.startXref < bytes.length);
    assert.ok(info.size > 0);
    assert.ok(info.root, 'every PDF has a /Root');
    assert.ok(['table', 'stream'].includes(info.style));
  });
}
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement `scan.ts`** — locate `startxref` from the tail, read the
      trailer dictionary (for a table) or the xref stream's dictionary (for a stream).
      Only the dictionary is parsed; the stream body is not decoded, because `/Size`
      and `/Root` live in the dictionary.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 3: Appending an incremental update (web)

**Files:**
- Create: `web/src/writer/incremental.ts`
- Test: `web/test/writer-incremental.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: `appendUpdate(base: Uint8Array, objects: Map<number, PdfValue>,
  trailerOverrides?: Record<string, PdfValue>): Uint8Array`, and
  `nextObjectNumber(info: TrailerInfo): number`

- [ ] **Step 1: Write the failing test** — the real acceptance criterion is that
      PDFium can still open the result.

```ts
test('a document with an appended update still opens and keeps its pages', async () => {
  const base = readFileSync(corpus('hello_world.pdf'));
  const info = scanTrailer(base);
  const n = nextObjectNumber(info);
  const out = appendUpdate(base, new Map([[n, { Type: name('Unused') }]]));

  assert.ok(out.length > base.length, 'update must be appended, not rewritten');
  assert.deepEqual(out.subarray(0, base.length), base, 'original bytes must survive');

  const doc = await PdfDocument.open(out);
  assert.equal(await doc.pageCount(), 1);
  assert.equal((await (await doc.page(0)).text()).trim(), 'Hello, world!');
});

test('the update carries /Prev so the original xref is still reachable', () => {
  const out = appendUpdate(base, new Map());
  const tail = new TextDecoder().decode(out.subarray(base.length));
  assert.match(tail, /\/Prev\s+\d+/);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement `incremental.ts`** — write the body, then an xref section in
      the same style the file already uses, then a trailer with `/Prev` pointing at the
      previous `startxref`, then `startxref` and `%%EOF`.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Widen to the corpus** — run Step 1's open-and-verify assertion across
      every corpus document, both xref styles. This is the gate for the whole task.
- [ ] **Step 6: Checkpoint.**

---

## Task 4: Signature reading (web)

Independent of Tasks 1-3; PDFium supplies everything.

**Files:**
- Modify: `web/src/document.ts`, `web/src/types.ts`, `web/src/index.ts`
- Test: `web/test/signatures.test.ts`
- Create: `conformance/corpus/signed_simple.pdf` (fixture, signed out of band)

**Interfaces:**
- Produces: `PdfDocument.signatures(): Promise<PdfSignature[]>` and the `PdfSignature`
  shape from spec §5.

- [ ] **Step 1: Write the failing test**

```ts
test('reads a signature and reports whether it covers the file', async () => {
  const doc = await PdfDocument.open(readFileSync(corpus('signed_simple.pdf')));
  const [sig] = await doc.signatures();
  assert.equal(sig.subFilter, 'adbe.pkcs7.detached');
  assert.ok(sig.contents.length > 0, 'the PKCS#7 blob must come back');
  assert.equal(sig.byteRange.length, 4);
  assert.equal(sig.coversWholeDocument, true);
});

test('an unsigned document reports no signatures', async () => {
  const doc = await PdfDocument.open(readFileSync(corpus('hello_world.pdf')));
  assert.deepEqual(await doc.signatures(), []);
});

// coversWholeDocument is computed, and getting it wrong is the failure that
// lets a signed document be silently amended.
test('a signature that stops short of EOF is not reported as covering it', async () => {
  const base = readFileSync(corpus('signed_simple.pdf'));
  const out = appendUpdate(base, new Map());          // amend after signing
  const [sig] = await (await PdfDocument.open(out)).signatures();
  assert.equal(sig.coversWholeDocument, false);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement** — bind `FPDF_GetSignatureCount`, `FPDF_GetSignatureObject`
      and the six `FPDFSignatureObj_Get*` calls; compute `coversWholeDocument` by
      comparing the last byte-range span against the file length.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 5: Port to iOS

**Files:**
- Create: `ios/Sources/PDFCora/Writer/{Values,Scan,Incremental}.swift`,
  `ios/Sources/PDFCora/PdfSignature.swift`
- Test: `ios/Tests/PDFCoraTests/WriterTests.swift`, `SignatureTests.swift`

- [ ] **Step 1: Port the tests first**, assertion for assertion, from Tasks 1-4.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Port the implementation.**
- [ ] **Step 4: Run `./scripts/test-ios.sh`, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 6: Port to Android

**Files:**
- Create: `android/pdfcora/src/main/java/com/pdfcora/writer/{Values,Scan,Incremental}.kt`,
  `PdfSignature.kt`; JNI bindings for the eight signature calls
- Test: `android/pdfcora/src/androidTest/java/com/pdfcora/{WriterTest,SignatureTest}.kt`

- [ ] **Step 1: Port the tests first.**
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Port the implementation**, including `pdfcora_jni.cpp` bindings.
- [ ] **Step 4: Run `./scripts/test-android.sh`, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 7: Conformance, demos and docs

- [ ] **Step 1:** Add signature expectations to `conformance/expectations.json` so all
      three platforms assert the same values for `signed_simple.pdf`.
- [ ] **Step 2:** Run the conformance suite on all three; confirm identical results.
- [ ] **Step 3:** Add a Signatures screen to each demo — list signatures, show signer
      reason and time, and flag `coversWholeDocument == false` prominently.
- [ ] **Step 4:** Extend the quickstart pages in `scripts/make-docs.sh` with a
      signature-reading example per platform.
- [ ] **Step 5:** Run `./scripts/make-docs.sh --no-serve` and `./scripts/package-all.sh`
      to confirm neither is broken by the new files.
- [ ] **Step 6:** Commit.

---

## Self-review notes

- Spec §6 (signing), §7 (verification) and §8 (redaction) are **not** in this plan.
  They are phases 3-6 and get their own plans; this one stops at the first useful
  release, per spec §12.
- `hexString` is used in Task 1's third test and must be exported from `values.ts`
  alongside `name` and `ref`.
- Task 4 depends on Task 3 only for its third test. If Tasks 1-3 slip, that assertion
  moves to Task 5 rather than blocking signature reading.
