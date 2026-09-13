# Signature Creation Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Create PAdES B-T signatures that Acrobat and `pdfsig` accept, from a caller-
supplied PKCS#12.

**Architecture:** Signing appends an incremental update carrying a signature field, a
signature dictionary and an updated AcroForm, then patches the real signature into a
fixed-size `/Contents` placeholder. Built in TypeScript first, then ported.

**Tech Stack:** TypeScript/Node, Swift/Security, Kotlin/JCA, PDFium `chromium/7243`.

**Spec:** `docs/superpowers/specs/2026-09-13-signatures-and-redaction-design.md` §6

## Scope correction

The spec's §4.1 describes `PdfWriter` as taking "the saved bytes of a document plus a set
of objects to add or replace". It never contemplated **reading**, and signing cannot
proceed without it: a signature field must be listed in the Catalog's `/AcroForm`, and
the page's `/Annots` must reference the widget. Both are existing objects that have to be
read, merged and rewritten — not replaced blindly, which would discard `/Pages`,
`/Outlines` and everything else.

Measured across the corpus:

| | count | consequence |
| --- | --- | --- |
| classic xref table | 16 / 20 | objects locatable by offset, no decompression |
| xref stream | 4 / 20 | the xref itself is Flate-compressed |
| object streams | 4 / 20 | objects live inside a compressed stream |
| Catalog not plain text | 1 / 20 (`bug_707673.pdf`) | unreachable without inflate |

So a reader is a prerequisite, and it needs Flate. That is available on every platform
without a dependency — Node `zlib`, Apple's Compression framework, `java.util.zip.Inflater`
— but it is real work the spec did not budget for, and it is why Tasks 1-2 exist before
any signing happens.

`PdfReader` is not wasted on signing alone: redaction (phases 5-6) must find and rewrite
`/Info`, page dictionaries and thumbnails, which needs exactly the same capability.

## Decisions taken

Two questions were left open in spec §13. Both are settled here; say so if either is wrong.

- **Timestamping in tests uses a stubbed RFC 3161 responder**, not a public TSA. CI must
  not depend on someone else's uptime, and a stub lets the failure paths be tested at all.
  A real TSA URL stays configurable for production.
- **The first release signs invisibly** — a signature field with an empty rect. A
  signature is valid without an appearance, appearances are pure presentation, and
  shipping one badly is worse than not shipping one. A later task can add it.

## Global Constraints

- No new runtime dependency in any SDK. Web's CMS step stays app-supplied (spec §6).
- The `/Contents` placeholder is fixed-size and patched in place; its byte length must
  never change, or every offset in the file shifts and the signature is worthless.
- Encrypted documents are refused, as `PdfWriter` already refuses them.
- A document this SDK signs must verify with **phase 3's verifier and with `pdfsig`**.
  Our own verifier agreeing with our own signer proves nothing on its own.

---

## Task 1: Object location and inflate (web)

**Files:**
- Create: `web/src/writer/inflate.ts`, `web/src/writer/xref.ts`
- Test: `web/test/xref.test.ts`

**Interfaces:**
- Produces: `inflate(bytes: Uint8Array): Uint8Array`,
  `buildXref(bytes: Uint8Array): XrefMap` where
  `XrefMap = Map<number, { offset: number } | { inObjectStream: number; index: number }>`

- [ ] **Step 1: Write the failing test**

```ts
test('locates every object in a classic xref table', () => {
  const bytes = read('hello_world.pdf');
  const xref = buildXref(bytes);
  // hello_world.pdf's table declares 0 7, so objects 1..6 are present.
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(xref.has(n), `object ${n}`);
});

test('locates objects behind an xref stream', () => {
  const xref = buildXref(read('embedded_attachments.pdf'));
  assert.ok(xref.size > 0);
});

/** The one corpus file whose Catalog is inside a compressed object stream. */
test('locates an object that lives inside an object stream', () => {
  const xref = buildXref(read('bug_707673.pdf'));
  const compressed = [...xref.values()].filter((e) => 'inObjectStream' in e);
  assert.ok(compressed.length > 0, 'this file must exercise the object-stream path');
});

test('follows /Prev through a chain of updates', () => {
  // An appended update must not hide the objects the original file declared.
  const base = read('hello_world.pdf');
  const info = scanTrailer(base);
  const updated = appendUpdate(base, new Map([[nextObjectNumber(info), { Type: name('X') }]]));
  const xref = buildXref(updated);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(xref.has(n), `object ${n} after update`);
});

test('a corrupt xref stream is refused, not half-read', () => {
  const bytes = new Uint8Array(read('embedded_attachments.pdf'));
  bytes[bytes.length - 20] ^= 0xff;          // damage near startxref
  assert.throws(() => buildXref(bytes), /xref|truncated|inflate/i);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** `inflate.ts` wraps `zlib.inflateSync`, raising a typed error
      rather than letting a native one escape. `xref.ts` walks the `/Prev` chain,
      handling both section styles, newest entry winning.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 2: Object reading (web)

**Files:**
- Create: `web/src/writer/read.ts`
- Test: `web/test/read-object.test.ts`

**Interfaces:**
- Consumes: Task 1, and the dictionary reader already in `scan.ts` (extract it so both
  use one implementation rather than two that can drift).
- Produces: `readObject(bytes, xref, number): PdfValue | undefined`,
  `readCatalog(bytes): { number: number; value: PdfValue }`

- [ ] **Step 1: Write the failing test**

```ts
test('reads the Catalog of a plain file', () => {
  const bytes = read('hello_world.pdf');
  const { value } = readCatalog(bytes);
  assert.equal(nameOf(value, 'Type'), 'Catalog');
  assert.ok(refOf(value, 'Pages'), 'a Catalog always has /Pages');
});

/** The Catalog here is inside a compressed object stream. */
test('reads a Catalog out of an object stream', () => {
  const { value } = readCatalog(read('bug_707673.pdf'));
  assert.equal(nameOf(value, 'Type'), 'Catalog');
});

test('reads an existing AcroForm when the document has one', () => {
  const bytes = read('text_form.pdf');
  const catalog = readCatalog(bytes).value;
  const acroForm = readObject(bytes, buildXref(bytes), refNumber(catalog, 'AcroForm')!);
  assert.ok(acroForm, 'text_form.pdf has an AcroForm');
});

test('a missing object is undefined, not an exception', () => {
  const bytes = read('hello_world.pdf');
  assert.equal(readObject(bytes, buildXref(bytes), 9999), undefined);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Move the dictionary reader out of `scan.ts` into a shared
      module and have both call it.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Sweep the corpus** — read the Catalog of every unencrypted document and
      assert `/Type /Catalog`. This is the gate for the task.
- [ ] **Step 6: Checkpoint.**

---

## Task 3: Placing an unsigned signature field (web)

Everything except the cryptography, so the document surgery can be proven on its own.

**Files:**
- Create: `web/src/sign/field.ts`
- Test: `web/test/sign-field.test.ts`

**Interfaces:**
- Produces: `addSignatureField(bytes, options): { bytes: Uint8Array; contentsAt: number;
  contentsLength: number; byteRange: number[] }`

- [ ] **Step 1: Write the failing test**

```ts
test('the document still opens and keeps its pages', async () => {
  const out = addSignatureField(read('hello_world.pdf'), { reservedBytes: 8192 }).bytes;
  const doc = await PdfDocument.open(out);
  assert.equal(await doc.pageCount(), 1);
});

test('PDFium sees a signature where there was none', async () => {
  const out = addSignatureField(read('hello_world.pdf'), { reservedBytes: 8192 }).bytes;
  const [signature] = await (await PdfDocument.open(out)).signatures();
  assert.ok(signature, 'FPDF_GetSignatureCount must find the new field');
  assert.equal(signature!.subFilter, 'ETSI.CAdES.detached');
});

/** The byte range must exclude exactly the placeholder, and nothing else. */
test('the byte range brackets the placeholder exactly', () => {
  const { bytes, contentsAt, contentsLength, byteRange } =
    addSignatureField(read('hello_world.pdf'), { reservedBytes: 8192 });
  assert.equal(byteRange[0], 0);
  assert.equal(byteRange[1], contentsAt);
  assert.equal(byteRange[2], contentsAt + contentsLength);
  assert.equal(byteRange[2] + byteRange[3], bytes.length);
});

test('an existing AcroForm is extended, not replaced', async () => {
  const before = await (await PdfDocument.open(read('text_form.pdf'))).page(0);
  const fieldsBefore = (await before.formFields()).length;

  const out = addSignatureField(read('text_form.pdf'), { reservedBytes: 8192 }).bytes;
  const after = await (await PdfDocument.open(out)).page(0);
  assert.equal((await after.formFields()).length, fieldsBefore + 1,
    'the original fields must survive');
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Write the signature dictionary, widget annotation and
      AcroForm; merge `/AcroForm` into the Catalog and the widget into the page's
      `/Annots`, both read via Task 2.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 4: Signing (web)

**Files:**
- Create: `web/src/sign/sign.ts`
- Modify: `web/src/types.ts`, `web/src/document.ts`
- Test: `web/test/sign.test.ts`
- Fixture: `conformance/fixtures/test-signer.p12` (self-signed, password `pdfiumkit`)

**Interfaces:**
- Produces: `PdfDocument.sign(options: PdfSignOptions): Promise<Uint8Array>` with
  `PdfSignOptions = { signer: CmsSigner; reason?: string; contactInfo?: string;
  reservedBytes?: number }`

Web ships **no** CMS implementation; the caller supplies `CmsSigner` (spec §6). The test
implements it with `node:crypto`, which is a test dependency and not a shipped one.

- [ ] **Step 1: Write the failing test**

```ts
test('a signed document verifies with our own verifier', async () => {
  const signed = await (await PdfDocument.open(read('hello_world.pdf')))
    .sign({ signer: nodeSigner(P12, 'pdfiumkit'), reason: 'Approved' });

  const doc = await PdfDocument.open(signed);
  const [signature] = await doc.signatures();
  assert.equal(signature!.coversWholeDocument, true);

  const verdict = await doc.verify(signature!, { trustAnchors: [selfSignedCert] });
  assert.equal(verdict.kind, 'valid');
});

/**
 * Our verifier agreeing with our signer proves nothing on its own. pdfsig is an
 * independent implementation and is the real gate.
 */
test('a signed document verifies with pdfsig', async () => {
  const signed = await (await PdfDocument.open(read('hello_world.pdf')))
    .sign({ signer: nodeSigner(P12, 'pdfiumkit') });
  writeFileSync(tmp, signed);

  const out = execFileSync('pdfsig', [tmp], { encoding: 'utf8' });
  assert.match(out, /Signature is Valid/);
  assert.match(out, /Total document signed/);
});

test('tampering with a document we signed is detected', async () => {
  const signed = await (await PdfDocument.open(read('hello_world.pdf')))
    .sign({ signer: nodeSigner(P12, 'pdfiumkit') });
  signed[100] ^= 0xff;

  const doc = await PdfDocument.open(signed);
  const [signature] = await doc.signatures();
  assert.equal((await doc.verify(signature!)).kind, 'digestMismatch');
});

test('the reason is carried into the signature', async () => {
  const signed = await (await PdfDocument.open(read('hello_world.pdf')))
    .sign({ signer: nodeSigner(P12, 'pdfiumkit'), reason: 'Approved by finance' });
  const [signature] = await (await PdfDocument.open(signed)).signatures();
  assert.equal(signature!.reason, 'Approved by finance');
});

/** A signature too large for the placeholder must fail loudly, not corrupt the file. */
test('a signature that will not fit is refused', async () => {
  await assert.rejects(
    () => (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: nodeSigner(P12, 'pdfiumkit'), reservedBytes: 64 }),
    /reserved|too large/i);
});

test('signing twice leaves the first signature intact', async () => {
  const once = await (await PdfDocument.open(read('hello_world.pdf')))
    .sign({ signer: nodeSigner(P12, 'pdfiumkit') });
  const twice = await (await PdfDocument.open(once))
    .sign({ signer: nodeSigner(P12, 'pdfiumkit') });

  const signatures = await (await PdfDocument.open(twice)).signatures();
  assert.equal(signatures.length, 2);
  assert.equal(signatures[0]!.coversWholeDocument, false, 'the first no longer covers all');
  assert.equal(signatures[1]!.coversWholeDocument, true);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Generate the fixture** and record its provenance in
      `conformance/fixtures/README.md`:

```bash
openssl req -x509 -newkey rsa:2048 -keyout k.pem -out c.pem -days 3650 -nodes \
  -subj "/CN=PdfiumKit Test Signer/O=PdfiumKit/C=GB"
openssl pkcs12 -export -out conformance/fixtures/test-signer.p12 \
  -inkey k.pem -in c.pem -passout pass:pdfiumkit
```

- [ ] **Step 4: Implement.** Place the field, compute the byte range, digest it, build
      the CMS via the caller's signer, patch the placeholder in place.
- [ ] **Step 5: Run the tests, confirm green** — `pdfsig` included.
- [ ] **Step 6: Checkpoint.**

---

## Task 5: Timestamping (web)

**Files:**
- Create: `web/src/sign/timestamp.ts`
- Test: `web/test/timestamp.test.ts`

- [ ] **Step 1: Write the failing test** against a stubbed RFC 3161 responder served
      from the test itself, asserting the request is a well-formed `TimeStampReq` whose
      `messageImprint` is the digest of the signature value, and that the response is
      embedded as an unsigned attribute.
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement**, with the TSA URL configurable and absent by default.
- [ ] **Step 4: Assert the failure paths** — a TSA that is unreachable, slow, or returns
      a rejection must raise `timestampFailed` and must **not** produce a half-signed
      document.
- [ ] **Step 5: Run the tests, confirm green.**
- [ ] **Step 6: Checkpoint.**

---

## Task 6: Port to iOS and Android

- [ ] **Step 1: Port the tests first**, assertion for assertion, for Tasks 1-5.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Port the implementation.** Inflate via Compression / `Inflater`; CMS via
      Security.framework primitives and JCA respectively, since neither platform needs
      the app-supplied signer that web does.
- [ ] **Step 4: Run both suites, confirm green, `pdfsig` cross-check included.**
- [ ] **Step 5: Checkpoint.**

---

## Task 7: Conformance, demos and docs

- [ ] **Step 1:** Add a signing round trip to the conformance suite: sign, re-open,
      verify, and assert `pdfsig` agrees. All three platforms, one contract.
- [ ] **Step 2:** Mutation-test that assertion.
- [ ] **Step 3:** Add signing to each demo's Signatures screen, using the committed test
      PKCS#12 and labelling it unmistakably as a test identity.
- [ ] **Step 4:** Document signing in each quickstart, including that the first release
      signs invisibly and that a TSA must be configured for B-T.
- [ ] **Step 5:** Run `./scripts/make-docs.sh --no-serve` and `./scripts/package-all.sh`.
- [ ] **Step 6:** Commit.

---

## Risks

- **Acrobat acceptance.** `pdfsig` is the automated gate, but Acrobat is the audience.
  A manual check before release is required, and a `pdfsig` pass does not substitute.
- **Object streams.** Reading them is new code on a path 4 of 20 corpus files exercise.
  Task 2's corpus sweep is the control.
- **Placeholder sizing.** 8192 bytes fits an RSA-2048 signature with a timestamp and
  leaves room; too small corrupts silently in most implementations, so Task 4 asserts a
  loud failure instead.
- **Two-signature documents.** Signing an already-signed file must leave the first
  signature verifiable. Tested, and the property that makes it work — appending rather
  than rewriting — is the one `PdfWriter` was built for.

## Self-review notes

- Redaction (spec §8) is **not** in this plan; it is phases 5-6 and reuses `PdfReader`.
- `nodeSigner`, `nameOf`, `refOf` and `refNumber` are test helpers to write in the files
  that use them.
- Task 3 asserts against `text_form.pdf` because it is the corpus document with an
  existing AcroForm; if that changes, the test needs another.
