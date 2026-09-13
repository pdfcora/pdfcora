# PdfiumKit — Digital Signatures and Redaction Design

Date: 2026-09-13
Status: Draft, pending review
Extends: `2026-09-12-pdfiumkit-sdk-design.md`

## 1. Purpose

Two features the SDK does not have today:

- **Digital signatures** — read existing signatures, verify them cryptographically,
  and create new ones.
- **Redaction** — remove content from a document so that it cannot be recovered,
  including the text layer, annotations, form values, metadata and attachments.

Success criteria:

- A signature created by this SDK verifies in Acrobat and in `pdfsig`.
- A redacted document, re-opened and text-extracted, contains none of the redacted
  string anywhere in the saved bytes — asserted by a test that fails if reverted.
- Both features present the same object model and error cases on all three platforms.

## 2. The constraint that shapes the design

PDFium exports 418 public functions in our build. **None of them creates a PDF
dictionary.** `FPDFAnnot_SetStringValue` is the only value setter and it writes
strings only. There is therefore no way, through the public API, to write:

- the `/V` signature dictionary,
- the `/ByteRange` array,
- a `/Contents` placeholder of a chosen size,
- document metadata (`FPDF_GetMetaText` exists; there is no setter).

Signing and metadata scrubbing must therefore bypass PDFium and append a
hand-written **incremental update** to the bytes PDFium produces. One component
serves both features.

What PDFium *does* provide, verified by symbol in the shipped binary:

| Need | API |
| --- | --- |
| Enumerate and read signatures | `FPDF_GetSignatureCount`, `FPDF_GetSignatureObject`, `FPDFSignatureObj_Get{ByteRange,Contents,Reason,Time,SubFilter,DocMDPPermission}` |
| Remove page content, regenerate | `FPDFPage_RemoveObject`, `FPDFPage_GenerateContent` |
| Remove annotations, attachments | `FPDFPage_RemoveAnnot`, `FPDFDoc_DeleteAttachment` |
| Split a partially covered text run | `FPDFText_SetText`, `FPDFText_SetCharcodes`, `FPDFText_LoadFont`, `FPDFText_GetCharBox`, `FPDFTextObj_Get{Font,FontSize}`, `FPDFPageObj_{Get,Set}Matrix` |

The last row is the one that makes correct redaction possible rather than
approximate. It was not obvious and was confirmed before this design was written.

## 3. Non-goals

- Signature appearance streams beyond a simple rendered block. A signature is valid
  without a visible appearance; elaborate visual design is the app's job.
- Certificate issuance, enrolment or key generation. The caller brings a key.
- Long-term validation (DSS, revocation embedding). The writer is designed not to
  preclude it; it is not in this scope. See §11.
- Redaction of raster content *within* an image. Images intersecting a region are
  removed whole, not repainted. See §8.4.

## 4. Architecture

Three layers, bottom up.

### 4.1 `PdfWriter` — incremental update writer

New, per-platform, no PDFium. Takes the saved bytes of a document plus a set of
objects to add or replace, and appends a valid incremental update: body, a
cross-reference section matching the original's style (table or stream), and a
trailer with `/Prev`.

Used by signing (§6) and by metadata scrub (§8.5). This is the highest-risk
component in the design and is built and tested first, on its own, against a corpus
of documents that use both xref styles.

### 4.2 Signatures

Reading is PDFium. Verification and signing are platform crypto composed over
`PdfWriter`.

### 4.3 Redaction

Entirely PDFium plus `PdfWriter` for the document-wide scrub.

## 5. Object model

Following the existing conventions — sealed hierarchies with an `unknown` case,
typed errors, PDF-space geometry.

```
PdfSignature
    index            Int
    reason           String?
    signingTime      Date?            // the signer's claimed time, not trusted
    subFilter        String?          // adbe.pkcs7.detached, ETSI.CAdES.detached, …
    byteRange        [Int]
    contents         Data             // the raw PKCS#7
    docMdpPermission Int?
    coversWholeDocument Bool          // byteRange spans the file as saved
```

`coversWholeDocument` is computed, not read: a signature whose byte range stops
short of the end of file does not protect what follows, and callers get that
wrong constantly if left to work it out.

```
PdfSignatureValidity = .valid(signer: PdfCertificate, timestamp: Date?)
                     | .digestMismatch          // bytes changed after signing
                     | .untrusted(chain: [PdfCertificate], reason: String)
                     | .expired(at: Date)
                     | .malformed(reason: String)
                     | .unsupported(subFilter: String)
```

```
PdfRedactionTarget = .region(PdfRect, onPage: Int)
                   | .textMatches(String, options: PdfSearchOptions)

PdfRedactionReport
    pages            [Int]
    textObjects      Int     // removed outright
    textObjectsSplit Int     // partially covered, rewritten
    images, paths    Int
    annotations      Int
    formFields       [String]
    metadataKeys     [String]
    attachments      [String]
```

The report is not decoration. Redaction is a compliance action, and "what did it
actually remove" is the question every reviewer asks.

## 6. Signing — PAdES B-T

Decisions taken: the caller supplies a PKCS#12 blob and password; the profile is
PAdES B-T with an RFC 3161 timestamp; on web the CMS step is pluggable.

```
1. Save the document (full), giving the base bytes.
2. Append, via PdfWriter, an incremental update containing:
     - a signature field widget annotation (created through PDFium if a visible
       appearance is wanted, otherwise written directly),
     - a signature dictionary with /Filter, /SubFilter /ETSI.CAdES.detached,
       /ByteRange [0 a b c] and /Contents <00…00> of a fixed reserved size,
     - an updated AcroForm with /SigFlags 3.
3. Compute the real /ByteRange, which excludes exactly the /Contents hex span.
4. Digest those two spans.
5. Produce the CMS SignedData over the digest, with the signing certificate chain.
6. Request an RFC 3161 timestamp over the signature value; embed it as an
   unsigned attribute.
7. Overwrite the /Contents placeholder in place. Byte length must not change.
```

Step 7 is why the placeholder is fixed-size and why the writer must be able to
patch bytes without re-serialising.

Platform crypto. **Corrected 2026-09-13:** an earlier draft of this table claimed iOS
would use Security.framework for CMS. It cannot. `CMSDecoder` and `CMSEncoder` ship only
in the macOS SDK; the iOS SDK has no public CMS API. Android exposes a PKCS#7 cert chain
through `CertificateFactory` but not the signed attributes. Every platform can perform
the underlying cryptography; none can parse the container.

| Platform | CMS container | Primitives | Timestamp |
| --- | --- | --- | --- |
| iOS | our own reader (§7.1) | CryptoKit / Security | `URLSession` to the TSA |
| Android | our own reader (§7.1) | JCA | `HttpURLConnection` |
| Web | app-supplied `CmsSigner` for signing; our own reader for verification | WebCrypto | app's fetch |

The web SDK ships **no** CMS implementation and gains no dependency. It defines:

```ts
interface CmsSigner {
  sign(digest: Uint8Array, algorithm: 'SHA-256'): Promise<Uint8Array>;  // PKCS#7
  timestamp?(signature: Uint8Array): Promise<Uint8Array>;               // RFC 3161
}
```

Apps that only read or redact carry nothing extra. This keeps the zero-dependency
promise while leaving signing available.

## 7. Verification

### 7.1 A minimal CMS reader

Since no platform provides one, verification parses the PKCS#7 itself. Deliberately
narrow: enough DER to walk a `SignedData` and extract the certificates, the
`messageDigest` signed attribute, the signature algorithm and the signature value.
Nothing is re-encoded, no ASN.1 beyond what those fields need, and it never runs on
data it has not first bounds-checked.

The cryptography itself is not ours — digests and signature verification use each
platform's primitives. Only the container walk is shared, which is what keeps the three
SDKs reporting identical verdicts.

```
1. Read /ByteRange and /Contents via PDFium.
2. Re-digest the byte ranges from the file as loaded.
3. Parse the CMS; compare the message digest. Mismatch -> .digestMismatch.
4. Build the chain to a trust anchor. Anchors default to the platform trust store
   and can be replaced by the caller.
5. Check validity dates; report .expired separately from .untrusted.
6. If a timestamp is present, verify it and prefer its time over the claimed one.
```

Revocation (CRL/OCSP) is **not** checked in this scope, and
`PdfSignatureValidity.valid` will say so in its documentation rather than implying
a stronger guarantee than it delivers.

A signature that verifies but does not cover the whole document is reported as
valid with `coversWholeDocument == false`. Conflating the two is how "signed"
documents get silently amended.

## 8. Redaction

### 8.1 Resolving targets

`.region` is used directly. `.textMatches` runs the existing search, then converts
each match's rects to regions. Both end up as a set of (page, rect).

### 8.2 Content removal

For each page object, compare `FPDFPageObj_GetBounds` to the region:

- **No intersection** — keep.
- **Fully covered** — `FPDFPage_RemoveObject`.
- **Partially covered, not text** — remove. Images and paths are not subdivided.
- **Partially covered text** — split, per §8.3.

Then `FPDFPage_GenerateContent`, and save with `.full`. Incremental save would
leave the original content stream in the file, which defeats the entire exercise.

### 8.3 Splitting a partially covered text run

The crux. For a text object intersecting the region:

```
1. FPDFText_CountChars / GetCharBox for per-character boxes.
2. Partition characters into surviving runs, dropping those whose box
   intersects the region.
3. Remove the original object.
4. For each surviving run, create a text object with FPDFPageObj_CreateTextObj
   using the original's font (FPDFTextObj_GetFont) and size, set its text with
   FPDFText_SetText, and apply a matrix translated to the run's origin.
```

Characters are dropped on intersection, not containment: a character half inside
the region is still legible and still present in the text layer.

### 8.4 What is not subdivided

An image that overlaps the region is removed entirely, not repainted with a hole.
Repainting means decoding, editing and re-encoding pixels, which changes the
image's compression and is a much larger piece of work. The report records the
removal so a caller can tell the difference. This is a stated limitation, not an
oversight.

### 8.5 Full scrub

Beyond page content:

- **Annotations** intersecting the region — `FPDFPage_RemoveAnnot`.
- **Form fields** intersecting the region — value cleared, then the widget removed.
- **Metadata** — `/Title`, `/Subject`, `/Keywords`, `/Author` and any custom key
  whose value contains a redacted string. No PDFium setter exists, so this goes
  through `PdfWriter`.
- **Attachments** — `FPDFDoc_DeleteAttachment` for any whose name or bytes contain
  a redacted string.
- **Page thumbnails** — removed via `PdfWriter`; they are a rendered copy of the
  page and can show what was removed. PDFium has getters only.

### 8.6 Verifying it actually worked

The test that matters: redact, save, re-open the saved bytes, and assert the
redacted string appears in neither the extracted text nor a raw byte scan of the
file. Mutation-tested — the assertion must fail when the removal is reverted.

## 9. Threading and errors

Both features run on the document's existing serial executor; no new concurrency.
Signing performs network I/O for the timestamp, which happens off that executor and
is passed back in.

New error cases, identical on all three platforms:

```
.signingFailed(reason:)        // key, CMS, or writer failure
.timestampFailed(reason:)      // TSA unreachable or rejected
.redactionFailed(reason:)      // content could not be rewritten
.unsupportedSignature(subFilter:)
```

## 10. Testing

- `PdfWriter` unit tests against both xref styles, asserting the result re-opens.
- A self-signed PKCS#12 fixture, committed, for signing tests.
- Round trip: sign, re-open, verify — must report `.valid`.
- Tamper: sign, flip one byte in the body, verify — must report `.digestMismatch`.
- Cross-check: at least one signature verified by `pdfsig` in CI, so a bug in our
  own verifier cannot mask a bug in our signer.
- Redaction: the §8.6 test, plus a partial-overlap case asserting the surviving
  half of a split run is still present and correctly positioned.
- All of the above added to `conformance/expectations.json` so the three platforms
  are held to one contract.

## 11. Risks

- **`PdfWriter` correctness.** A malformed incremental update produces a file that
  opens in some readers and not others. Mitigated by building it first, alone, and
  testing that output re-opens in PDFium and `pdfsig`.
- **Acrobat acceptance.** Verifying in our own code proves little. The external
  `pdfsig` cross-check is the guard; Acrobat itself is a manual check before release.
- **Redaction completeness.** The failure mode is silent and serious. §8.6 is the
  control, and anything not covered is named in §8.4 rather than left implied.
- **Scope.** This is two projects. §12 sequences them so signatures ship first.

## 12. Phasing

1. `PdfWriter` — incremental updates, all three platforms, tested alone.
2. Signature **reading** — PDFium only, all three platforms, demos and docs.
3. Signature **verification** — platform crypto, trust anchors, tamper tests.
4. Signature **creation** — PAdES B-T, PKCS#12, TSA, `pdfsig` cross-check.
5. Redaction — content and text splitting.
6. Redaction — full scrub and report.

Each phase ends with all three platforms at parity, tests green, and the
conformance contract updated. Phase 2 is the first useful release.

## 13. Open questions

- Which TSA to use in tests. A public one makes CI network-dependent; a stubbed
  RFC 3161 responder is preferable and is assumed here.
- Whether a visible signature appearance is required in the first release, or
  whether invisible signatures suffice until an app asks.
