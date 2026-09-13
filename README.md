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

All three demos have an **Editor** screen — open a file and it lands there — where
the page behaves like a form rather than a picture of one. Every field is a live
control sitting on its own rectangle: type straight into text fields, tap checkboxes
and radio buttons, pick from dropdowns. No dialogs. Editing tools sit alongside: drag
to draw ink, tap to place a note, drag to highlight an area, and drag to **redact** —
which removes the objects themselves and reports what went, rather than painting a box
over them.

It works by rendering the page **without** the `forms` flag — PDFium then draws each
widget's frame but not its value — and positioning native controls over the field
rects with `PdfViewTransform`.

## Installing

Each SDK has been verified by consuming it from a project **outside** this repo, not
just by running its own tests.

**Web** — `npm install @pdfiumkit/web`. The PDFium `.wasm` ships inside the package, so
there is nothing else to host. Node resolves it automatically; in a browser pass URLs
via `configureEngine` or `PdfWorker`.

**iOS** — Swift Package Manager. `Package.swift` uses a *local* binary target for
development. For a release the xcframework must be hosted, because `vendor/` is not
committed and a consumer resolving from git would otherwise get no binary:

```bash
./scripts/package-ios.sh     # writes the zip, its checksum, and the snippet to paste
```

**Android** — Maven. `gradle :pdfiumkit:publishToMavenLocal` publishes
`com.pdfiumkit:pdfiumkit:0.1.0`; the AAR is 9.3 MB and carries all four ABIs, of which
Play delivers one per device.

**AI, separately and optionally** — `pdfiumkit-ai` (npm), `PdfiumKitAI` (SPM product),
`com.pdfiumkit:pdfiumkit-ai` (Maven). The core has no AI dependency and never gains one:
`scripts/check-core-deps.sh` reads the resolved graph on all three platforms and fails
the build if it does. Today the package ships **no feature** — only the availability
model, the custom-provider interface and the proposal/apply API that later features build
on. Adding it does not raise your minimum OS.

## Feature coverage

Every row is exercised by the shared conformance suite on every platform that claims it.

| | iOS | Android | Web |
|---|---|---|---|
| Open from bytes / file, password | ✅ | ✅ | ✅ |
| Page count, size, rotation | ✅ | ✅ | ✅ |
| Render (scaled or exact pixels) | ✅ | ✅ | ✅ |
| Cancellable progressive render | ⚠️ | — | — |
| Recoverable from an engine hang | — | — | ✅ (Worker) |
| Text extraction, char count | ✅ | ✅ | ✅ |
| Text hash-verified vs reference engine | ✅ | ✅ | ✅ |
| Search with rects | ✅ | ✅ | ✅ |
| Character bounding boxes | ✅ | ✅ | ✅ |
| Annotations: read (15 kinds) | ✅ | ✅ | ✅ |
| Annotations: ink, note, remove | ✅ | ✅ | ✅ |
| Annotations: highlight/underline/strikeout | ✅ | — | — |
| Form fields: read (8 kinds) | ✅ | ✅ | ✅ |
| Form fields: set text, checkbox, option | ✅ | ✅ | ✅ |
| Outline / bookmarks | ✅ | ✅ | ✅ |
| Links | ✅ | ✅ | ✅ |
| Metadata, permissions | ✅ | ✅ | ✅ |
| Attachments: list | ✅ | ✅ | ✅ |
| Attachments: extract bytes | ✅ | ✅ | ✅ |
| Save (full / incremental) | ✅ | ✅ | ✅ |
| Raw PDFium escape hatch | ✅ | — | — |

⚠️ iOS rendering is cancellable *between* progressive steps, which covers a slow
render. It cannot interrupt a render that hangs *inside* a single PDFium call — see
Known limits.

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

**Test totals:** 29 iOS (simulator) · 28 Android (device) · 27 Web · 12 host.

Two iOS test classes are excluded from normal runs — `HangProbeTests` and
`BlastRadiusTests` — because they deliberately trigger the render hang, which spins
a core and stops the test process from exiting. Run them with `-only-testing`.

## Known limits

### A malformed page can hang rendering, unkillably

Sweeping all 293 documents in PDFium's test corpus through the full API surface found
**zero crashes** — but one document, `bug_451265.pdf` (1,230 bytes), makes rendering
hang indefinitely.

Everything else about that file is fine: open, page count, page size, text extraction,
annotations, and form fields all complete in ~20 ms. Only `render()` hangs.

It is not merely slow, and it is **not interruptible**. `FPDF_RenderPageBitmap_Start`
never returns, so the pause callback is never consulted and control never comes back to
the SDK. No cancellation mechanism on any platform can break out of it, including the
iOS progressive path.

**What this means for you:** if you render PDFs that users supply, a 1 KB file can wedge
the thread doing the rendering, permanently. A timeout around the `await` is not enough —
the work keeps running.

This is PDFium behaviour, not a binding bug; it reproduces with raw `FPDF_*` calls.

**On Web there is a supported way out** — see below. On iOS and Android the damage is
contained but the thread is not recoverable — see the measurements below.

#### How far the damage spreads, measured

The hang reproduces natively, not only in WASM: on the iOS simulator the render never
returns and the process spins a core at ~99%.

The per-document executor design contains it. Measured by deliberately starting more
simultaneous hangs than the machine has cores:

| | hangs started | other documents still render? | unrelated async work? |
|---|---|---|---|
| iOS (14 cores) | 16 | ✅ | ✅ |
| Android (8 cores) | 10 | ✅ | ✅ |

So a hung render costs:

- **that one document, permanently** — every later call on it never returns
- **one thread and one core**, spinning until the process exits

It does *not* cascade: other documents, and the rest of the app, keep working. Process
isolation would only buy back the thread and the CPU, not containment.

**What to do in an app:** race your own deadline around a render of an untrusted
document, and on timeout treat that `PdfDocument` as lost — stop using it and open a
fresh one. Do not retry on the same document; it will never answer again.

### Web: run untrusted documents in a Worker

`PdfWorker` runs the whole SDK inside a Worker and exposes the *same* document and page
API, so calling code is unchanged. What you gain is `terminate()`, which is the only way
to recover from the hang above.

```ts
import { PdfWorker } from '@pdfiumkit/web'

const worker = new PdfWorker({
  workerUrl: new URL('./pdfium-worker.js', import.meta.url),
  glueUrl:   new URL('./vendor/pdfium.esm.js', import.meta.url),
  wasmUrl:   new URL('./vendor/pdfium.esm.wasm', import.meta.url),
})

const doc  = await worker.open(bytes)
const page = await doc.page(0)
const img  = await page.render({ width: 1200 })   // identical to the in-process API

// If a render does not come back, this is your escape hatch.
worker.terminate()   // pending calls reject with PdfError code 'cancelled'
```

It needs the **ESM** build of the glue (`pdfium.esm.js`); a module worker cannot load the
classic `pdfium.js` via `importScripts`. Rendered pixels are transferred rather than
copied across the boundary.

Verified in Chromium against the hanging document: the render never returns, the main
thread keeps ticking uninterrupted, and `terminate()` rejects the pending call with
`cancelled`. See `web/demo/worker-test.html`.

### Scale

Measured on generated multi-page documents (`node conformance/make-large-doc.mjs`,
then `node --expose-gc conformance/scale.mjs`). These are **WASM-on-Node** numbers;
native iOS and Android are faster.

| | 200 pages, 18.8 MB | 400 pages, 2.4 MB | 300 pages, 1.2 MB |
|---|---|---|---|
| open | 26 ms | <1 ms | <1 ms |
| thumbnail every page (120px) | 0.3 s | 0.1 s | 0.6 s |
| per page: mean / p95 | 1.6 / 2.0 ms | 0.2 / 0.3 ms | 1.9 / 2.0 ms |
| single 1600px render | 14 ms | 8 ms | 18 ms |
| text, all pages | 65 ms | 6 ms | 153 ms |
| save | 181 ms | 11 ms | 2 ms |

**No memory leak.** Opening, rendering, and closing the 18.8 MB document 40 times
leaves the WASM heap flat at 25.6 MB and RSS plateaued. Note that RSS never *falls*
after `close()` — Emscripten does not return heap to the OS — so watch the WASM heap,
not RSS, when looking for leaks here.

### Robustness sweep

```bash
node conformance/robustness.mjs [corpusDir]   # default: PDFium testing/resources
```

Full-corpus results, most recent run:

| outcome | count |
|---|---|
| completed | 265 |
| rejected on open, typed | 23 (9 password, 14 corrupt) |
| typed error during use | 4 |
| **hang** | **1** |
| **crash** | **0** |
| **untyped throw** | **0** |

## Design notes worth knowing

- **Threading.** Each document owns a serial executor — an `actor` on iOS, a
  single-threaded dispatcher on Android, a promise chain on Web. You cannot corrupt
  memory by calling from the wrong thread; misuse raises `PdfError.closed` instead.
- **Coordinates.** `PdfRect` is always PDF space (bottom-left origin). Conversion is an
  explicit call in both directions — `PdfViewTransform.toView` to draw an overlay,
  `.toPdf` to work out what a tap hit — plus `PdfRect.contains` for hit-testing. There
  is no implicit Y-flip anywhere.
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
