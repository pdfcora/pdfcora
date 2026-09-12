# PdfiumKit

A PDF SDK for **iOS, Android, and Web**, built on PDFium. One object model, expressed
idiomatically in Swift, Kotlin, and TypeScript; thread-safe by construction; typed
errors instead of native crashes.

```swift
let doc  = try await PdfDocument(url: url)
let page = try await doc.page(0)
let img  = try await page.render(width: 1200)
let hits = try await page.text.search("invoice")
```
```kotlin
PdfDocument.open(file).use { doc ->
    val page = doc.page(0)
    val bmp  = page.render(width = 1200)
    val hits = page.text.search("invoice")
}
```
```ts
const doc  = await PdfDocument.open(bytes)
const page = await doc.page(0)
const img  = await page.render({ width: 1200 })
const hits = await page.text.search('invoice')
```

## Getting a working checkout

```bash
node scripts/make-vendor-manifest.mjs   # only when the PDFium artifacts change
./scripts/fetch-vendor.sh               # populates vendor/, verifies every checksum
npm test                                # host suite (Node + WASM)
```

`vendor/` is never committed. `vendor.manifest.json` pins the engine revision and the
SHA-256 of every artifact, and the fetch script refuses anything that does not match.

## Running each platform

| | Build | Test |
|---|---|---|
| iOS | `xcodebuild build -scheme PdfiumKit -destination 'platform=iOS Simulator,name=<device>'` | same with `test` |
| Android | `cd android && gradle :pdfiumkit:assembleDebug` | `gradle :pdfiumkit:connectedDebugAndroidTest` (needs a device or emulator) |
| Web | `cd web && npm run build` | `npm test` |

Demos: `ios/Demo` (SwiftUI, generate with `xcodegen`), `android/demo` (Compose),
`web/demo` (serve the repo root and open `/web/demo/index.html`).

## Feature coverage

Every row is exercised by the shared conformance suite on every platform that claims it.

| | iOS | Android | Web |
|---|---|---|---|
| Open from bytes / file, password | ✅ | ✅ | ✅ |
| Page count, size, rotation | ✅ | ✅ | ✅ |
| Render (scaled or exact pixels) | ✅ | ✅ | ✅ |
| Cancellable progressive render | ✅ | — | — |
| Text extraction, char count | ✅ | ✅ | ✅ |
| Text hash-verified vs reference engine | ✅ | ✅ | ✅ |
| Search with rects | ✅ | ✅ | ✅ |
| Character bounding boxes | ✅ | — | — |
| Annotations: read (15 kinds) | ✅ | ✅ | ✅ |
| Annotations: ink, note, remove | ✅ | ✅ | ✅ |
| Annotations: highlight/underline/strikeout | ✅ | — | — |
| Form fields: read (8 kinds) | ✅ | ✅ | ✅ |
| Form fields: set text, checkbox, option | ✅ | ✅ | ✅ |
| Outline / bookmarks | ✅ | ✅ | ✅ |
| Links | ✅ | — | — |
| Metadata, permissions | ✅ | ✅ | ✅ |
| Attachments: list | ✅ | ✅ | ✅ |
| Attachments: extract bytes | ✅ | — | — |
| Save (full / incremental) | ✅ | ✅ | ✅ |
| Raw PDFium escape hatch | ✅ | — | — |

Gaps are real and deliberate, not oversights — the object model, threading, error
model, and conformance harness came first on all three platforms, and the remaining
rows are mechanical additions along paths that already exist.

## Engine

PDFium pinned at **`chromium/7243`**, built with V8, XFA, and Skia disabled. That
exports **448 of 460** public PDFium functions, verified byte-identical in coverage
across the iOS static library, all four Android ABIs, and the WASM build. The 12
absent functions are XFA, V8, Skia, and the Windows-HDC renderer.

Rebuilding is rarely needed:

```bash
./scripts/build-pdfium.sh <macos|ios|android|wasm> release
```

### Binary cost, measured

| | Size |
|---|---|
| Android `.so`, arm64, full API | **4.77 MB** |
| Android `.so`, armeabi-v7a | 3.29 MB |
| Web `pdfium.wasm` | 3.8 MB raw → **1.5 MB brotli** |

A separate "raw bindings" package was considered and rejected: linking the full API
costs only ~0.6 MB on Android and ~0.2 MB on iOS over a minimal core, because
rendering one page already pulls in the parser, font stack, codecs, and graphics
layer. See spec §3.1.

## Conformance

`conformance/expectations.json` is the contract **all three SDKs are tested against**:
page counts, page geometry, and open-failure modes for 18 corpus documents spanning
basic, form, encrypted, annotation, text, and regression categories.

```bash
node conformance/select-corpus.mjs   # refresh corpus/ from the PDFium source tree
node conformance/generate.mjs        # regenerate expectations
node conformance/validate.mjs        # check them
```

Expected values come from PDFium itself, with page counts independently cross-checked
against poppler so the suite is not purely self-referential.

**Rendering** is checked positionally: Android and Web both assert that a known RGB
test page places blue, green, and red at the coordinates the reference engine does —
which catches channel-order bugs that pixel counting alone cannot, since the page has
equal numbers of red and blue pixels.

**Text** is checked by exact character count plus a SHA-256 of the normalised page
text, on all three platforms. This is the sharpest check in the suite: the three SDKs
share an engine but have three independently written UTF-16 decoders, and this is
where an off-by-one on the string terminator would show up. Normalisation strips
whitespace by explicit codepoint rather than `\s`, because `\s` is not portable —
U+00A0 matches it in JavaScript but not in Java's `Character.isWhitespace`.

**Test totals:** 28 iOS (simulator) · 25 Android (device) · 24 Web · 12 host.

## Design notes worth knowing

- **Threading.** Each document owns a serial executor — an `actor` on iOS, a
  single-threaded dispatcher on Android, a promise chain on Web. You cannot corrupt
  memory by calling from the wrong thread; misuse raises `PdfError.closed` instead.
- **Coordinates.** `PdfRect` is always PDF space (bottom-left origin). Conversion to
  view space is an explicit call. There is no implicit Y-flip anywhere.
- **Saving.** `full` is the default. `incremental` preserves the original bytes and
  existing signatures, but — verified against `chromium/7243` — does **not** persist
  annotations created in the same session.
- **Checkboxes.** Set via the PDF data model (`V`/`AS`), not synthetic clicks;
  PDFium's click path needs FFI callbacks this SDK does not install.
- **Unknown kinds.** Every sealed hierarchy carries an `unknown` case, so annotation
  and field types this SDK does not model are surfaced rather than dropped.

## Licensing

PdfiumKit is distributed as a binary that statically links PDFium and six bundled
third-party libraries. **FreeType is used under the FreeType License (FTL)**, not
GPLv2, which keeps the whole SDK permissively licensed.

The FTL requires this credit in the documentation of any product using the SDK:

> Portions of this software are copyright © 2024 The FreeType Project
> (https://freetype.org). All rights reserved.

Full notices for PDFium, FreeType, Little CMS, OpenJPEG, libjpeg-turbo, zlib, AGG,
and ICU are in [`NOTICE.md`](NOTICE.md), assembled by inspecting the shipped binary
rather than from build flags alone. That file needs a legal sign-off before the first
public release.

## Status

Pre-release. The API is settled enough to build against and the conformance suite
guards behaviour, but nothing is published to SPM, Maven Central, or npm yet.
Outstanding before publishing: legal sign-off on `NOTICE.md`, and publishing the
vendor artifacts as checksummed release assets.

## Documentation

- Design: `docs/superpowers/specs/2026-09-12-pdfiumkit-sdk-design.md`
- Foundation plan: `docs/superpowers/plans/2026-09-12-phase1-foundation.md`
