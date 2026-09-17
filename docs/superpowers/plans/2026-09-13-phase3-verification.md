# Signature Verification Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Verify the signatures a document carries — prove the bytes have not changed
since signing, and report trust separately from integrity.

**Architecture:** No platform ships a usable CMS parser, so we write a narrow one: enough
DER to walk a `SignedData` and pull out the certificates, the `messageDigest` signed
attribute, the algorithm and the signature value. The cryptography itself is each
platform's own primitives. Built in TypeScript first, then ported, against the same
fixture and the same `pdfsig` ground truth.

**Tech Stack:** TypeScript/Node, Swift/CryptoKit, Kotlin/JCA, PDFium `chromium/7243`.

**Spec:** `docs/superpowers/specs/2026-09-13-signatures-and-redaction-design.md` §7

## Global Constraints

- No new runtime dependency in any SDK.
- The container walk is shared by design so all three report identical verdicts; only
  the primitives differ.
- **Integrity and trust are separate answers.** A signature whose digest matches but
  whose issuer is unknown is `.untrusted`, never `.valid`. Collapsing the two is the
  defect this whole phase exists to avoid.
- Revocation (CRL/OCSP) is out of scope; `.valid` documents that it does not check.
- The parser never indexes without bounds-checking first. Malformed input returns
  `.malformed`, never a crash.

## Ground truth

`pdfsig conformance/corpus/signed_unh_iol.pdf` reports, and every task below is measured
against it rather than against our own reader:

```
- Signer Certificate Common Name: UNH-IOL
- Signing Hash Algorithm: SHA-256
- Signature Type: adbe.pkcs7.detached
- Signed Ranges: [0 - 151484], [156392 - 297957]
- Total document signed
- Signature Validation: Signature is Valid.
- Certificate Validation: Certificate issuer is unknown.
```

That last pair is the fixture's real value: a signature that is cryptographically
**valid** and simultaneously **untrusted**.

The chain, confirmed with `openssl pkcs7 -print_certs`, is a **single self-signed
certificate** — subject and issuer are both `CN=UNH-IOL, O=University of New Hampshire`.
That is why the issuer is unknown, and it makes the anchor test in Task 4 exact: supply
that one certificate and the same signature must become `.valid`.

---

## Task 1: DER reader (web)

**Files:**
- Create: `web/src/cms/der.ts`
- Test: `web/test/der.test.ts`

**Interfaces:**
- Produces: `readTlv(bytes, offset): { tag, length, contentStart, contentEnd, end }`,
  `children(bytes, tlv): Tlv[]`, `readOid(bytes, tlv): string`,
  `readInteger(bytes, tlv): bigint`

- [ ] **Step 1: Write the failing test**

```ts
test('reads a short-form TLV', () => {
  // SEQUENCE { INTEGER 1 }
  const bytes = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);
  const tlv = readTlv(bytes, 0);
  assert.equal(tlv.tag, 0x30);
  assert.equal(tlv.length, 3);
  assert.equal(tlv.end, 5);
  assert.equal(children(bytes, tlv).length, 1);
});

test('reads long-form lengths', () => {
  // A 300-byte OCTET STRING: 0x04 0x82 0x01 0x2C
  const bytes = new Uint8Array(4 + 300);
  bytes.set([0x04, 0x82, 0x01, 0x2c]);
  assert.equal(readTlv(bytes, 0).length, 300);
});

test('decodes an OID', () => {
  // 1.2.840.113549.1.9.4 — the messageDigest attribute
  const bytes = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04]);
  assert.equal(readOid(bytes, readTlv(bytes, 0)), '1.2.840.113549.1.9.4');
});

/** Malformed input is expected, not exceptional: it arrives from untrusted files. */
test('refuses a length that runs past the buffer', () => {
  assert.throws(() => readTlv(new Uint8Array([0x30, 0x7f]), 0), /truncated|bounds/i);
});

test('refuses an indefinite length, which DER forbids', () => {
  assert.throws(() => readTlv(new Uint8Array([0x30, 0x80, 0x00, 0x00]), 0), /indefinite/i);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement `der.ts`.** Every read bounds-checks before indexing.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Fuzz it.** Feed 10,000 random and truncated mutations of the fixture's
      PKCS#7 blob; assert every one either parses or throws, and none hangs or throws a
      `RangeError`. This is the gate for the task.
- [ ] **Step 6: Checkpoint.**

---

## Task 2: CMS SignedData extraction (web)

**Files:**
- Create: `web/src/cms/signedData.ts`
- Test: `web/test/signed-data.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `parseSignedData(pkcs7: Uint8Array): SignedData` where
  `SignedData = { certificates: Uint8Array[]; signerSerial: bigint; digestAlgorithm: string;
  signatureAlgorithm: string; signedAttrs?: Uint8Array; messageDigest?: Uint8Array;
  signature: Uint8Array }`

`signedAttrs` is returned **re-tagged as a SET** (`0x31`), because that, not the
`[0] IMPLICIT` form stored in the file, is what the signature is computed over. Getting
this wrong makes every signature appear invalid.

- [ ] **Step 1: Write the failing test**

```ts
const pkcs7 = (await signatureOf('signed_unh_iol.pdf')).contents;

test('extracts the signer certificate and algorithms', () => {
  const cms = parseSignedData(pkcs7);
  assert.ok(cms.certificates.length > 0, 'the chain must come back');
  assert.equal(cms.digestAlgorithm, '2.16.840.1.101.3.4.2.1');   // SHA-256, per pdfsig
  assert.ok(cms.signature.length > 0);
});

test('extracts the messageDigest signed attribute', () => {
  const cms = parseSignedData(pkcs7);
  assert.equal(cms.messageDigest?.length, 32, 'SHA-256 is 32 bytes');
});

/** The signature covers the SET encoding, not the [0] IMPLICIT one stored in the file. */
test('signed attributes are re-tagged as a SET', () => {
  assert.equal(parseSignedData(pkcs7).signedAttrs?.[0], 0x31);
});

test('rejects a blob that is not SignedData', () => {
  assert.throws(() => parseSignedData(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])), /signedData|content type/i);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement `signedData.ts`.**
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 3: Digest verification (web)

Proves the signed byte ranges still hash to what the signature committed to.

**Files:**
- Create: `web/src/cms/verify.ts`
- Test: `web/test/verify-digest.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2, and `PdfSignature.byteRange` from phase 2.
- Produces: `digestOverRanges(bytes, byteRange, algorithm): Promise<Uint8Array>`,
  `checkDigest(bytes, signature): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
test('the signed ranges hash to the messageDigest attribute', async () => {
  const bytes = read('signed_unh_iol.pdf');
  const [signature] = await (await PdfDocument.open(bytes)).signatures();
  assert.equal(await checkDigest(bytes, signature), true);
});

/** The whole point. Flipping one byte inside a signed range must be caught. */
test('a single changed byte inside a signed range breaks the digest', async () => {
  const bytes = read('signed_unh_iol.pdf');
  const [signature] = await (await PdfDocument.open(bytes)).signatures();
  const tampered = new Uint8Array(bytes);
  tampered[100] ^= 0xff;                       // inside [0 - 151484]
  assert.equal(await checkDigest(tampered, signature), false);
});

/** Bytes outside the ranges are, correctly, not covered. */
test('a byte changed in the /Contents gap does not break the digest', async () => {
  const bytes = read('signed_unh_iol.pdf');
  const [signature] = await (await PdfDocument.open(bytes)).signatures();
  const gapStart = signature.byteRange[1]! + 1;
  const poked = new Uint8Array(bytes);
  poked[gapStart] ^= 0xff;
  assert.equal(await checkDigest(poked, signature), true);
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement `verify.ts`** using WebCrypto's `crypto.subtle.digest`.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 4: Signature and chain verification (web)

**Files:**
- Modify: `web/src/cms/verify.ts`, `web/src/types.ts`, `web/src/document.ts`
- Test: `web/test/verify.test.ts`

**Interfaces:**
- Produces: `PdfDocument.verify(signature: PdfSignature, options?: PdfVerifyOptions):
  Promise<PdfSignatureValidity>`, with
  `PdfVerifyOptions = { trustAnchors?: Uint8Array[] }` and the
  `PdfSignatureValidity` union from spec §5.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * pdfsig says both "Signature is Valid" and "Certificate issuer is unknown".
 * Reporting this as .valid would be the exact defect this phase exists to avoid.
 */
test('a valid signature from an unknown issuer is untrusted, not valid', async () => {
  const doc = await PdfDocument.open(read('signed_unh_iol.pdf'));
  const [signature] = await doc.signatures();
  const verdict = await doc.verify(signature!);
  assert.equal(verdict.kind, 'untrusted');
  assert.ok(verdict.chain.length > 0, 'the chain is reported even when not trusted');
});

test('the same signature is valid when its own root is supplied as an anchor', async () => {
  const doc = await PdfDocument.open(read('signed_unh_iol.pdf'));
  const [signature] = await doc.signatures();
  const cms = parseSignedData(signature!.contents);
  const verdict = await doc.verify(signature!, { trustAnchors: [cms.certificates.at(-1)!] });
  assert.equal(verdict.kind, 'valid');
  assert.match(verdict.signer.commonName, /UNH-IOL/);      // pdfsig's common name
});

test('tampering is reported as a digest mismatch, not as untrusted', async () => {
  const bytes = new Uint8Array(read('signed_unh_iol.pdf'));
  bytes[100] ^= 0xff;
  const doc = await PdfDocument.open(bytes);
  const [signature] = await doc.signatures();
  assert.equal((await doc.verify(signature!)).kind, 'digestMismatch');
});

test('a malformed PKCS#7 is reported, not thrown', async () => {
  const doc = await PdfDocument.open(read('signed_unh_iol.pdf'));
  const [signature] = await doc.signatures();
  const broken = { ...signature!, contents: new Uint8Array([1, 2, 3]) };
  assert.equal((await doc.verify(broken)).kind, 'malformed');
});
```

- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Implement.** Verify the signature over the re-tagged signed attributes
      with `crypto.subtle.verify`, then build and check the chain against the anchors,
      defaulting to none-trusted rather than to a browser store that tests cannot pin.
- [ ] **Step 4: Run the tests, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 5: Port to iOS

**Files:**
- Create: `ios/Sources/PDFCora/Cms/{Der,SignedData,Verify}.swift`
- Test: `ios/Tests/PDFCoraTests/VerificationTests.swift`

- [ ] **Step 1: Port the tests first**, assertion for assertion from Tasks 1-4.
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Port the implementation.** Digests via CryptoKit; signature verification
      via `SecKeyVerifySignature`; certificates via `SecCertificateCreateWithData`.
- [ ] **Step 4: Run `./scripts/test-ios.sh`, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 6: Port to Android

**Files:**
- Create: `android/pdfcora/src/main/java/com/pdfcora/cms/{Der,SignedData,Verify}.kt`
- Test: `android/pdfcora/src/androidTest/java/com/pdfcora/VerificationTest.kt`

- [ ] **Step 1: Port the tests first.**
- [ ] **Step 2: Run them, confirm they fail.**
- [ ] **Step 3: Port the implementation.** `MessageDigest`, `Signature` and
      `CertificateFactory` from JCA. No Bouncy Castle.
- [ ] **Step 4: Run `./scripts/test-android.sh`, confirm green.**
- [ ] **Step 5: Checkpoint.**

---

## Task 7: Conformance, demos and docs

- [ ] **Step 1:** Extend `conformance/generate.mjs` to record pdfsig's two verdicts —
      `signatureValid` and `certificateTrusted` — per signature, and assert both on all
      three platforms.
- [ ] **Step 2:** Mutation-test that assertion: flip one expectation, confirm the suite
      fails, restore.
- [ ] **Step 3:** Show the verdict on each demo's Signatures screen, keeping integrity
      and trust visually distinct. Replace the "not verified" note now that it is false.
- [ ] **Step 4:** Add a verification example to each quickstart in `scripts/make-docs.sh`,
      stating plainly that revocation is not checked.
- [ ] **Step 5:** Run `./scripts/make-docs.sh --no-serve` and `./scripts/package-all.sh`.
- [ ] **Step 6:** Commit.

---

## Self-review notes

- Signing (spec §6) and redaction (§8) are **not** in this plan; they are phases 4-6.
- Task 4's second test derives the anchor from the fixture's own chain rather than
  committing a root certificate, so no separate fixture is needed.
- `signatureOf()` used in Task 2's test is a helper to add in that test file: open the
  corpus document and return its first `PdfSignature`.
- The fixture's chain is one self-signed certificate (verified), so `certificates.at(-1)`
  in Task 4's anchor test is that certificate. A deeper chain would need a second
  fixture to exercise intermediate handling; note it as a gap rather than pretend the
  single-certificate case covers it.
