# PdfiumKit — Licensing Design

Date: 2026-09-15
Status: Implemented 2026-09-15
Extends: `2026-09-12-pdfiumkit-sdk-design.md`

## 1. Purpose

Sell the SDK by feature. Without a license key the whole SDK works as a trial, with a
watermark. A paid key unlocks the modules it lists; a module the key does not list still
works, with the watermark.

Success criteria:

- The same key string behaves identically on iOS, Android and web, asserted by a shared
  conformance fixture.
- A trial or unlicensed save carries a visible watermark in page content that every PDF
  viewer shows, and a document signed without a signing license still verifies in `pdfsig`.
- A bad, expired or foreign key never throws and never crashes an app: it falls back to
  the trial and says why.
- The existing test suites pass unchanged, running under a test key.

**What this protects against.** Honest customers exceeding what they bought. It does not
stop someone determined to patch the check out — trivially on web, with effort on native.
It is a meaningful deterrent only when the SDK ships as binaries (an XCFramework, the AAR,
minified JavaScript); `scripts/package-all.sh` builds those, and the source packages give
no protection.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Without a key | Everything works; rendered pages and saved files carry a watermark |
| Paid limits | The key lists feature modules, sold in any combination |
| Watermark reach | Rendered pages **and** saved files, stamped into page content |
| Expiry | A key covers every SDK version released on or before its expiry date |
| Binding | iOS bundle IDs, Android package names, web hostnames; Node needs `server` |
| Developer builds | Not exempt; a key lists `localhost` or debug app IDs if wanted |
| Network | None. Verified offline against an embedded public key |
| Verifying signatures | Free, in core |
| Viewer, sync, UI components | Free, in core |

## 3. Modules

A valid key always includes **core** and adds the modules it lists.

| Module | Covers |
| --- | --- |
| `core` | Open, page count and sizes, render, text, search, metadata, outline, attachments, links, page objects, reading annotations and form fields, listing and verifying signatures, save, the headless viewer, sync, the UI components |
| `editing` | Adding and removing annotations (ink, highlight, underline, strikeout, note), setting page rotation |
| `forms` | Setting form field values: text, checked, option |
| `signing` | Creating a signature |
| `redaction` | Redacting |
| `ai` | Everything in `pdfiumkit-ai`: answers and summaries |

Editing through the viewer calls the same document methods, so it is gated as `editing`.

## 4. The key

```
pk1.<base64url payload>.<base64url signature>
```

The signature is ECDSA P-256 with SHA-256 over the decoded payload bytes (the UTF-8
JSON), in raw 64-byte `r‖s` form. WebCrypto verifies that form directly; iOS (CryptoKit
`P256.Signing`) and Android (`SHA256withECDSA`, after conversion to DER) convert. ECDSA
P-256 because every platform already verifies it for signatures, with no new dependency;
Ed25519 is unavailable on Android below API 33.

Payload:

```json
{
  "v": 1,
  "id": "lic_8f2c",
  "customer": "Acme",
  "modules": ["editing", "signing"],
  "ios": ["com.acme.app"],
  "android": ["com.acme.app", "com.acme.app.debug"],
  "web": ["acme.com", "*.acme.com", "localhost"],
  "server": false,
  "expires": "2027-09-15"
}
```

Unknown module names are ignored, so a key issued for a future module works on an older
SDK. Missing platform lists mean the key does not cover that platform.

### Checks, in order

The first failure decides the reason reported. Each has a code that the shared fixture
compares on every platform: `noKey`, `malformed`, `badSignature`, `unsupportedVersion`,
`revoked`, `expired`, `wrongApp`.

1. The key has three parts, and the payload is JSON of the shape above.
2. The signature verifies against the public key built into the SDK.
3. `v` is a version this SDK understands.
4. `id` is not in the SDK's built-in revocation list.
5. The SDK's release date is on or before `expires`. The release date is a constant in
   each platform's source, set by the release script; nothing reads the device clock.
6. The running app matches:
   - iOS: `Bundle.main.bundleIdentifier` is in `ios`.
   - Android: `context.packageName` is in `android`.
   - Web in a browser: `location.hostname` of the page matches `web`. `*.acme.com`
     matches any subdomain but not `acme.com` itself; entries compare case-insensitively.
   - Web with no `location` (Node): `server` is `true`.

## 5. API

The type is `PdfLicense` rather than `PdfiumKit`: a Swift type named after its own module
breaks qualified names in a generated `.swiftinterface`, which binary distribution needs.

```swift
PdfLicense.setKey("pk1.…")
PdfLicense.status   // .licensed(customer: "Acme", modules: [.editing, .signing])
                    // .trial(reason: "key is for com.acme.app, this app is com.acme.dev")
```

```kotlin
PdfLicense.setKey(context, "pk1.…")
PdfLicense.status   // PdfLicenseStatus.Licensed(customer, modules) / Trial(reason)
```

```ts
import { PdfLicense } from '@pdfiumkit/web';
await PdfLicense.setKey('pk1.…');
PdfLicense.status;  // { kind: 'licensed', customer, modules } / { kind: 'trial', reason }
```

- Call it before opening documents. A later call takes effect for later checks; a
  document already marked stays marked.
- Calling it again replaces the key. Never throws.
- With no key set, `status` is `trial` with reason "no license key set".
- The first time the SDK watermarks anything, it logs one warning with the reason
  (`os_log`, `Log.w`, `console.warn`).
- `PdfWorker` sends the key and the page's hostname to its worker, where the check runs.
- On web, verification uses WebCrypto, which is asynchronous: `setKey` returns a promise,
  and opening a document waits for a pending check.

## 6. Marking

Each document carries one flag: **needs watermark**.

- In trial mode, every document needs the watermark from the moment it opens.
- With a valid key, every entry point of a paid module calls the gate first:
  `license.use(.editing, on: document)`. If the key lacks the module, the document is
  marked. The operation then runs normally either way.
- The mark lasts until the document closes. A saved file needs no mark: the watermark
  is already in its content.
- A sync follower replays edits through the same methods, so its document is marked by
  the same gate.
- `pdfiumkit-ai` checks `ai` per call; it has no document to mark (§7.4).

## 7. The watermark

"PdfiumKit trial", Helvetica Bold (a standard PDF font, so nothing is embedded), grey at
25% opacity, diagonal, scaled to the page. It is built with PDFium itself on every
platform, so it looks the same everywhere and needs no canvas in Node. The web build
already exports every function required: `FPDF_CreateNewDocument`, `FPDFPage_New`,
`FPDFPageObj_NewTextObj`, `FPDFText_SetText`, `FPDFPageObj_SetFillColor`,
`FPDFPageObj_Transform`, `FPDFPage_InsertObject`, `FPDFPage_GenerateContent`,
`FPDF_RenderPageBitmapWithMatrix`.

### 7.1 Rendering

When the document needs the watermark, after the page renders the SDK renders a
same-sized scratch page holding only the watermark onto the same bitmap, with the same
matrix and no background fill. The document is not modified.

### 7.2 Saving

When the document needs the watermark, `data` / `toByteArray` / `toBytes`:

1. save as today, but always in full;
2. open those bytes as a temporary document, insert the watermark into every page's
   content, and regenerate the content;
3. save the temporary document in full and return that.

**Always in full.** Measured on 2026-09-15: PDFium `chromium/7243` writes an empty
incremental update after `FPDFPage_GenerateContent`, whether or not the page is still
loaded, so a stamped watermark survives only a full save. A requested incremental save of
a marked document is therefore written in full, and the documentation says so. A licensed
document keeps both modes.

The open document is never modified, so repeated saves never stamp twice, and a
following render still overlays exactly one watermark.

### 7.3 Signing

Signing works on the document's original bytes. When `signing` is not licensed, or in
trial, the SDK first stamps those bytes (§7.2, so in full), then signs the result as an
incremental update. The new signature covers the watermark and verifies.

**Trial limitation, documented:** because the stamp is a full rewrite, signatures that
were already in the file no longer verify in the result. A licensed signing keeps them.

### 7.4 AI

When `ai` is not licensed, the answer or summary text is prefixed with
"PdfiumKit trial — ". Quotes and citations are not changed, so grounding still verifies.

### 7.5 Redaction

Redaction marks the document; the watermark is added at save time, after the content is
removed. The watermark's text must not appear in any redaction test's search terms.

## 8. Issuing keys

`tools/license/issue.mjs`, using Node's `crypto`:

- `issue.mjs keygen --out <dir>` writes a P-256 private key and the public key as raw
  bytes, printed ready to paste into the three platform constants.
- `issue.mjs sign --private-key <file> --customer … --modules … --ios … --android …
  --web … [--server] --expires YYYY-MM-DD --id …` prints a key.

The production private key never enters the repository. The production public key is a
constant in each platform's source, the same 65 bytes everywhere.

## 9. Testing

- **Test key pair.** Committed under `conformance/license/`, marked test-only. Test code
  replaces the embedded public key, revocation list and release date through an internal
  hook: `@testable` on iOS, `internal` on Android, an unexported function on web. A
  shipped SDK has no public way to accept a test key.
- **Existing suites.** Each sets a test key with every module, for every app ID and
  `server`, once at setup. Their expectations do not change.
- **Conformance fixture** `conformance/license/cases.json`, run on all three platforms:
  valid; tampered payload; tampered signature; malformed; unknown `v`; revoked `id`;
  expired before the release date; expiring on it; wrong bundle ID, package name and
  hostname; wildcard matching and non-matching; Node without and with `server`; unknown
  module ignored. Each case records the expected status and reason code, and the
  platforms must agree.
- **Behaviour tests** on each platform:
  - trial render has watermark pixels; licensed render has none;
  - trial save, reopened, has the watermark text on every page; licensed save does not;
  - two saves of a marked document stamp once each;
  - an `editing` call without the module marks the document; with it, does not;
  - unlicensed signing verifies, on the host with `pdfsig`, and contains the watermark;
  - an incremental save of a marked document comes back as a full save with the watermark;
  - unlicensed redaction still removes the redacted text from the saved bytes;
  - unlicensed AI output carries the prefix and its quotes still verify;
  - an invalid key never throws.

## 10. Out of scope

- Online activation, revocation fetching, usage counting.
- Binary packaging and obfuscation (§1).
- A key management service or customer portal.
- Removing an existing watermark from a document saved during a trial.
