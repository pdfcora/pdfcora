# PdfiumKit — Cross-Platform PDF SDK Design

Date: 2026-09-12
Status: Approved design, pending implementation plan

## 1. Purpose

A PDF SDK for iOS, Android, and Web built on PDFium, with an object-oriented API
that is idiomatic in each language, thread-safe by construction, and broad enough
that developers rarely hit a wall.

Success criteria:

- A developer renders their first page in under five minutes from install.
- Concurrent misuse cannot corrupt memory. Misuse raises a typed error instead.
- Every operation that can fail reports *why*, distinguishably.
- The same conformance suite passes on all three platforms.
- Binary cost stays near the engine's floor (~5 MB/ABI mobile, ~1.5 MB brotli web).

Distribution is staged: built to public-SDK quality from day one, shipped privately
first, open-sourced once the API has settled on at least one platform.

## 2. Non-goals

- XFA forms, V8/JavaScript execution, and Skia rendering. All three are disabled in
  the engine build and out of scope.
- Wrapping all 448 PDFium functions in the object model. The curated model plus a
  raw escape hatch covers the ground; mechanical completeness is not a goal.
- Backwards compatibility with the previous `PDFCoriumKit` API. This is a clean break.

## 3. Engine baseline

PDFium pinned at `chromium/7243`, built by `build-pdfium.sh` (carried over from the
previous tree) with:

```
pdf_enable_v8=false  pdf_enable_xfa=false
pdf_bundle_freetype=true  pdf_is_complete_lib=true
```

This exports **448 of 460** public PDFium functions, verified identical across the
iOS static library, all four Android ABIs, and the WASM build. The 12 absent
functions are XFA (`FPDF_BStr_*`, `FSDK_*`), V8 (`FPDF_GetRecommendedV8Flags`),
Skia (`FPDF_RenderPageSkia`, `FPDF_FFLDrawSkia`), and the Windows-HDC
`FPDF_RenderPage`. None affects a viewer, editor, or forms use case.

The engine revision is recorded in build metadata and exposed at runtime as
`PdfiumKit.engineVersion`, so a bug report identifies the engine that produced it.

### 3.1 Binary cost — measured

Transitive object-file closure from the archive, measured 2026-09-12:

| Entry points | Android arm64 | iOS arm64 |
|---|---|---|
| Curated core (~27 fns) | 4.5 MB | 4.4 MB |
| All 448 exported | 5.1 MB | 4.6 MB |
| Link everything | 7.2 MB | 6.3 MB |

Exposing the full API costs +0.6 MB on Android and +0.2 MB on iOS, because a core
that renders one page already links the parser, font stack, codecs, and graphics
layer — roughly 500 of 900 objects. The remaining functions are mostly entry points
into code that is already present.

**Consequence:** ship one package per platform with raw access always available.
A separate "raw" module was considered and rejected — it would add a build target,
a CI job, and a docs section per platform to save under a megabyte.

The model predicts 4.5 MB for the previous 26-function bridge against an observed
5.8 MB stripped `.so`; the difference is static libc++ and ELF overhead. Note the
model works at object-file granularity, so release builds using `--gc-sections` may
land lower. The delta is expected to hold. Web could not be modelled, because
Emscripten fixes exports at build time; if the 1.5 MB brotli payload ever becomes a
problem, a curated-export `.wasm` is a later optimisation, not a day-one split.

## 4. Object model

Everything hangs off a document. PDFium handles never appear in the public API.
Each type owns its handle and its children.

```
PdfDocument ──┬── pages: PdfPage[]
              ├── outline: PdfOutlineItem (tree)
              ├── attachments, signatures
              └── metadata, permissions, save()

PdfPage ──────┬── render(...) -> platform image
              ├── text: PdfTextPage      (extract, search, charBoxes, rects)
              ├── annotations: PdfAnnotation[]
              ├── formFields: PdfFormField[]
              ├── links: PdfLink[]
              └── objects: PdfPageObject[]   (text / path / image)
```

Nine types, named identically on all three platforms. Only the spelling differs:

```swift
let doc  = try await PdfDocument(url: url, password: nil)
let page = try await doc.page(0)
let img  = try await page.render(width: 1200, options: [.annotations, .forms])
let hits = try await page.text.search("invoice", options: .caseInsensitive)
```
```kotlin
// all suspend; shown inside a coroutine scope
val doc  = PdfDocument.open(file)
val page = doc.page(0)
val bmp  = page.render(width = 1200, annotations = true, forms = true)
val hits = page.text.search("invoice", caseSensitive = false)
```
```ts
const doc  = await PdfDocument.open(bytes)
const page = await doc.page(0)
await page.render(canvas, { width: 1200, annotations: true, forms: true })
const hits = await page.text.search('invoice', { caseSensitive: false })
```

Three rules the model enforces:

- **No library lifecycle calls.** The engine initialises on first use.
- **Collections are lazy.** `doc.pages` does not load 900 pages; indexing loads one.
- **Mutation lives on the object it mutates.** `page.annotations.addHighlight(...)`,
  not `editor.addHighlight(page, ...)`. Helper-bag classes (`FPEditor`, `FPForm`)
  do not exist in this design.

## 5. Attributes and value types

No raw `Int` flags, no string-keyed lookups, no bare tuples.

### 5.1 Sealed hierarchies

The three polymorphic families become sealed hierarchies, giving exhaustive matching
and typed members instead of casting. Each language uses its natural construct:
Swift an enum whose cases wrap concrete handle-owning classes, Kotlin a `sealed
class`, TypeScript a discriminated union on `kind`.

```swift
switch annotation {
case .highlight(let h):  h.quads, h.color
case .ink(let i):        i.strokes
case .widget(let w):     w.field
case .freeText(let t):   t.contents, t.fontSize
case .unknown(let u):    u.subtypeCode
}
```
```kotlin
when (field) {
    is PdfFormField.Text     -> field.value = "John Doe"
    is PdfFormField.CheckBox -> field.isChecked = true
    is PdfFormField.ComboBox -> field.select(field.options[0])
}
```
```ts
if (obj.kind === 'image') { await obj.extract() }
```

- `PdfAnnotation` → highlight, ink, freeText, widget, square, circle, line, stamp,
  text, link, underline, strikeout, squiggly, fileAttachment, **unknown**
- `PdfFormField` → text, checkBox, radioButton, comboBox, listBox, pushButton,
  signature, **unknown**
- `PdfPageObject` → text, path, image, shading, form, **unknown**

Every hierarchy carries an `unknown` case. PDFium can return subtypes the model does
not name, and dropping them silently would be a correctness bug. This also softens
the main cost of sealed hierarchies — that adding a case is a breaking change for
consumers writing exhaustive matches.

### 5.2 Enums and option sets

Closed sets become enums; bitmasks become option sets.

```swift
field.flags.contains(.required)     // OptionSet, not Int
annotation.appearance[.normal]      // AppearanceMode, not Int32
page.rotation = .degrees90          // enum, not 0...3
```

### 5.3 Metadata

A struct with typed members, not string lookups: `doc.metadata.title`, `.author`,
`.creationDate` (a real date type). A `subscript(custom:)` covers non-standard keys.

### 5.4 Geometry carries its coordinate space

Mixing PDF space (bottom-left origin) with view space (top-left) is the most common
bug in PDF integration work, so the type system catches it. `PdfRect` is PDF space.
Conversion is explicit:

```swift
rect.converted(to: .view(of: page, scale: 2))
```

There is no implicit Y-flip anywhere in the API.

### 5.5 Colour

One `PdfColor` with platform bridges (`UIColor`/`Color`, `@ColorInt`, CSS string).
Never four loose `UInt8` parameters in a signature.

## 6. Threading and lifetime

### 6.1 Threading

**Each document owns a serial executor.** Every PDFium call originating from that
document or anything downstream of it — pages, annotations, form fields — hops onto
that executor. Two threads can never be inside one document simultaneously, which is
precisely PDFium's constraint. Separate documents get separate executors, so
rendering two files runs genuinely in parallel.

The public API is therefore async: Swift `async`/`await`, Kotlin `suspend`, and
TypeScript `Promise`. On Web the executor is a Worker, keeping the main thread free.

A developer cannot corrupt memory by calling from the wrong thread.

### 6.2 Cancellation

Long renders use PDFium's progressive API (`FPDF_RenderPageBitmap_Start` /
`_Continue`), mapped onto Swift `Task` cancellation, coroutine cancellation, and
`AbortSignal`. Scrolling away from a page stops its render rather than completing it
wastefully.

### 6.3 Lifetime

Native handles need deterministic release. Only Swift provides it for free.

| | Primary | Safety net |
|---|---|---|
| Swift | `deinit`; children retain parents | — (ARC is deterministic) |
| Kotlin | `Closeable` + `use { }` | reference-queue reaper logs a leak warning |
| TypeScript | `await using` / `dispose()` | `FinalizationRegistry` |

Closing a document closes its pages first, so release ordering cannot be got wrong.
Using anything after close throws `PdfError.closed` — **never** a segfault. This
single rule converts the worst class of bug in the previous codebase into a
catchable error.

## 7. Errors

Typed, never silent, identical cases on all three platforms.

```swift
enum PdfError: Error {
  case passwordRequired, wrongPassword
  case corrupt(detail: String), unsupportedSecurity
  case pageOutOfRange(Int, count: Int)
  case closed, cancelled
  case saveFailed(reason: String)
  case invalidOperation(reason: String)
  case engine(code: Int)        // unmapped FPDF_GetLastError, with the code
}
```

`FPDF_GetLastError` is mapped rather than discarded. No operation that can fail for
an interesting reason returns a bare `Bool`, and no failure is reported only to a
console.

## 8. Raw escape hatch

`document.rawHandle` plus the generated C declarations, documented as unsafe and
subject to the document's executor. Present so nothing is ever blocked; not
prominent, because the object model is the API.

## 9. Packaging and distribution

### 9.1 Build inputs stay out of git

PDFium artifacts total 72 MB for Android alone. Committing them is what produced the
previous tree's stale binaries and dangling `../../` paths. Instead,
`build-pdfium.sh` output is published once as a checksummed GitHub Release asset,
and a fetch script pulls it into a gitignored `vendor/`.

### 9.2 Consumer artifacts

| | Artifact | Notes |
|---|---|---|
| iOS | SPM `binaryTarget` XCFramework + CocoaPods podspec | checksummed, hosted on Releases |
| Android | `com.pdfiumkit:pdfiumkit` on Maven Central | App Bundle splits per ABI automatically |
| Web | `@pdfiumkit/web` on npm, ESM + `.d.ts` | `.wasm` a separate asset with configurable resolution; Vite/webpack/Next compatible |

Semver for the SDK, with the engine revision tracked separately.

### 9.3 Repository layout

```
PdfiumKit-v2/
  ios/          Swift package + demo
  android/      Gradle modules + demo
  web/          npm package + demo
  conformance/  shared PDF corpus + expected-results JSON
  scripts/      build-pdfium.sh, fetch-vendor.sh, manifest generator
  tools/host/   host-side PDFium (WASM under Node) for tooling and oracles
  vendor/       gitignored, populated by fetch
  docs/
```

No committed artifacts. No paths escaping the repo root.

## 10. Verification

Four layers, because "reliable" must be measurable.

1. **Shared conformance suite.** One PDF corpus plus one JSON file of expected
   results — page counts, extracted text, field values, annotation geometry —
   executed by each platform's native test runner. This is what proves the three
   SDKs behave identically rather than merely looking similar.
2. **Golden-image render tests.** Per-platform baselines compared with a perceptual
   threshold, since rasterisation legitimately differs between CoreGraphics, Skia,
   and WASM. Catches the channel-order class of bug found in the previous JNI bridge.
3. **Robustness.** Malformed and hostile PDFs from PDFium's own corpus. The bar:
   every one raises a typed error and none crashes. Plus ASan and leak runs on the
   native layers.
4. **CI on every commit.** GitHub Actions — macOS runner for iOS, emulator for
   Android instrumented tests, Playwright for Web.

The corpus needs AcroForms, encrypted, CJK/RTL, linearised, tagged, and large
documents. PDFium's own test corpus covers much of this.

## 11. Demo apps

One per platform, identical feature set, doubling as the sample gallery. Every
screen is short enough to paste into documentation.

Viewer (scroll/zoom) · Search · Outline · Thumbnails · Annotations including ink
signature · Forms · Text selection and copy · Document info, metadata, attachments ·
Page operations (rotate/reorder/delete) · Export and share

Building the same ten screens three times is the most honest test of whether the API
is pleasant in each language. If a screen is awkward in Kotlin, the API is wrong,
not the demo.

## 12. Code standards

**Inline comments: minimal.** Only non-obvious logic, real constraints, or
workarounds. Nothing that restates the code.

```swift
// PDFium page space is bottom-left origin; UIKit is top-left.
let flipped = pageHeight - rect.maxY
```

**Public API doc comments: kept, but only where they add information the signature
does not.** These drive IDE autocomplete and are part of the product. The test is
whether the line says something the name did not.

```swift
/// Renders at `width` points; height follows the page aspect ratio.
/// Thread-safe — serialized on the document's queue.
public func render(width: Int, options: RenderOptions) async throws -> UIImage
```

`/// Page width in points.` above `var width: CGFloat` is noise and does not belong.

## 13. Material to carry over

The previous tree at `~/Projects/Lab/PDFCoriumKit` and the build tree at
`~/Projects/Lab/pdfiumkit` are read-only source material:

- `build-pdfium.sh` — carried over nearly intact.
- Android CMake/Gradle/JNI wiring — demonstrably builds and correctly keeps PDFium
  symbols out of the ABI.
- `build_xcframework.sh` modulemap technique for exposing PDFium to Swift via
  `@_implementationOnly`.
- Web adapter's solved problems: progressive loading via `FPDFAvail`, the
  `FPDF_FILEWRITE` save shim, widget appearance normalisation.
- The iOS wrapper's 141 correct PDFium call sites, as reference for call patterns.

## 14. Open questions

1. **FreeType licensing.** The build sets `pdf_bundle_freetype=true`. PDFium is
   BSD-3-Clause; FreeType is dual-licensed FTL/GPLv2. A public SDK needs a correct
   `NOTICE`. Obligations must be verified against the actual source tree rather than
   from memory. **Blocks open-sourcing, not development.**
2. **Test corpus sourcing.** How much comes from PDFium's corpus versus documents
   supplied for real-world coverage.
3. **Minimum platform versions.** iOS deployment target, Android `minSdk` (previously
   21), and browser baseline. Affects available concurrency primitives —
   notably whether `await using` and `FinalizationRegistry` can be relied on.

## 15. Phasing

Four cycles, each with its own plan:

1. **Foundation** — repo layout, vendor fetch, `build-pdfium.sh` integration,
   conformance corpus and harness, CI skeleton.
2. **iOS** — first platform. The API shape gets proven here; lessons flow into the
   other two.
3. **Android**
4. **Web**

Platforms are sequential rather than parallel so that API mistakes are found once
rather than three times.
