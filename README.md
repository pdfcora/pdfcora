# PDFCora

A PDF SDK for **iOS, Android, Web and the server**, built on PDFium. One object model,
expressed idiomatically in Swift, Kotlin, TypeScript and Java; thread-safe by
construction; typed errors instead of native crashes.

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

**Desktop and server engines.** `scripts/build-pdfium.sh` also builds `macos` (a universal
static library) and `linux` (x64 and arm64, in a container, against Chromium's own sysroot
so the result runs on older glibc than the build image). Those two targets are optional
everywhere: the manifest records them only when they exist, and `fetch-vendor.sh` skips
them otherwise, so a mobile or web checkout is unaffected. The Java SDK links against
them — `scripts/build-jni.sh` builds its JNI library from exactly these artifacts.

Building macOS needs an SDK this PDFium revision understands: macOS 26 and later removed
the fortify wrappers and ship a libc++ this clang cannot parse, so the script selects an
older Xcode when one is installed and warns when it cannot.

Linking against the Linux engines requires **lld**, not GNU ld: the objects carry CREL
relocations, and `/usr/bin/ld` rejects their `.eh_frame` sections. Chromium's own lld ships
in the checkout at `third_party/llvm-build/Release+Asserts/bin`, and `-fuse-ld=lld` is
enough.

## Running each platform

| | Build | Test |
|---|---|---|
| iOS | `xcodebuild build -scheme PDFCora -destination 'platform=iOS Simulator,name=<device>'` | same with `test` |
| Android | `cd android && gradle :pdfcora:assembleDebug` | `gradle :pdfcora:connectedDebugAndroidTest` (needs a device or emulator) |
| Web | `cd web && npm run build` | `npm test` |
| Node | `cd node && npm run build` | `./scripts/test-node.sh` |
| Java | `./scripts/build-jni.sh && cd java && gradle build` | `./scripts/test-java.sh` |

Demos: `ios/Demo` (SwiftUI, generate with `xcodegen`), `android/demo` (Compose),
`web/demo` (serve the repo root and open `/web/demo/index.html`).

Samples: `samples/` holds one small app per feature area — **core** (open, text, search,
form fields, render, save), **AI** (summarise, propose redactions a person accepts), **UI**
(the viewer component with a custom toolbar and theme), **agents** (MCP server and WebMCP)
and **pipeline** (tag for accessibility, sign, countersign). Core exists for all five SDKs,
AI for everything but Java, UI for iOS, Android and web, agents on Node and in the browser,
and pipeline on Java. Each consumes the SDK the way an app would and has a README;
`samples/README.md` is the index.

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

**Web** — `npm install @pdfcora/web`. The PDFium `.wasm` ships inside the package, so
there is nothing else to host. Node resolves it automatically; in a browser pass URLs
via `configureEngine` or `PdfWorker`.

**iOS** — Swift Package Manager. `Package.swift` uses a *local* binary target for
development. For a release the xcframework must be hosted, because `vendor/` is not
committed and a consumer resolving from git would otherwise get no binary:

```bash
./scripts/package-ios.sh     # writes the zip, its checksum, and the snippet to paste
```

**Android** — Maven. `gradle :pdfcora:publishToMavenLocal` publishes
`com.pdfcora:pdfcora:0.1.0`; the AAR is 9.3 MB and carries all four ABIs, of which
Play delivers one per device.

**Node** — `npm install @pdfcora/node`. A thin layer over the web package rather than a
second implementation: it re-exports the whole API and adds file and PNG helpers and a
licence key from the environment. Same WebAssembly engine, so nothing to compile. See
`node/README.md`.

**Java** — Maven, `com.pdfcora:pdfcora:0.1.0`, Java 17 or newer on macOS and Linux
(x86-64 and arm64). This one *is* a separate implementation: a JNI layer over the native
engine, carrying the document API — open, pages, render, text, search, metadata, save —
plus annotations, form filling, redaction, tagging, signing and the viewer state layer.
`./scripts/build-jni.sh` builds the native libraries the jar carries. See `java/README.md`.

**AI, separately and optionally** — `@pdfcora/web-ai` (npm), `PDFCoraAI` (SPM product),
`com.pdfcora:pdfcora-ai` (Maven). The core has no AI dependency and never gains one:
`scripts/check-core-deps.sh` reads the resolved graph on all three platforms and fails
the build if it does. Today the package ships **no feature** — only the availability
model, the custom-provider interface and the proposal/apply API that later features build
on. Adding it does not raise your minimum OS.

## Feature coverage

✅ means built and covered by tests on that platform; rows marked *untested* are built but
have no test yet. The core rows also run through the shared conformance suite, which asserts the
same results on all three platforms.

| | iOS | Android | Web |
|---|---|---|---|
| Open from bytes / file, password | ✅ | ✅ | ✅ |
| Page count, size, rotation | ✅ | ✅ | ✅ |
| Render (scaled or exact pixels) | ✅ | ✅ | ✅ |
| Cancellable progressive render | ⚠️ *untested* | — | — |
| A hung render does not take the app down | ⚠️ watchdog | ⚠️ watchdog | ✅ Worker |
| Text extraction, char count | ✅ | ✅ | ✅ |
| Text hash-verified vs reference engine | ✅ | ✅ | ✅ |
| Search with rects | ✅ | ✅ | ✅ |
| Character bounding boxes | ✅ | ✅ | ✅ |
| Page objects (text, path, image…) | ✅ | ✅ | ✅ |
| Annotations: read (15 kinds) | ✅ | ✅ | ✅ |
| Annotations: ink, note, remove | ✅ | ✅ | ✅ |
| Annotations: highlight, underline, strikeout | ✅ | ✅ | ✅ |
| Form fields: read (8 kinds) | ✅ | ✅ | ✅ |
| Form fields: set text, checkbox, option | ✅ | ✅ | ✅ |
| Outline / bookmarks | ✅ | ✅ | ✅ |
| Links | ✅ | ✅ | ✅ |
| Metadata, permissions | ✅ | ✅ | ✅ |
| Attachments: list, extract bytes | ✅ | ✅ | ✅ |
| Save (full / incremental) | ✅ | ✅ | ✅ |
| Signatures: read and verify | ✅ | ✅ | ✅ |
| Signing (PAdES B-B), cross-checked with `pdfsig` | ✅ | ✅ | ✅ bring a CMS signer |
| Signature timestamps (PAdES B-T) | ⚠️ *untested* | ⚠️ *untested* | ✅ |
| Redaction, checked in the saved bytes | ✅ | ✅ | ✅ |
| Viewer: state, zoom, events, sync, editing | ✅ | ✅ | ✅ |
| UI component with configurable toolbar | ✅ SwiftUI | ✅ Compose | ✅ DOM element |
| License keys and trial watermark | ✅ | ✅ | ✅ |
| Redaction suggestions, reviewed as marks in the viewer | ✅ | ✅ | ✅ |
| Smart form filling from a profile, reviewed as labelled marks | ✅ | ✅ | ✅ |
| Create form fields; detect blanks on flat PDFs (lines, boxes, underscores, squares) | ✅ | ✅ | ✅ |
| Structure tree read; figure alt text and decorative marking, checked with veraPDF | ✅ | ✅ | ✅ |
| Alt text proposals for figures | ✅ provider | ✅ ML Kit, provider | ✅ provider |
| Remediation: tag untagged content, rule-based proposals, checked with veraPDF | ✅ | ✅ | ✅ |
| Tagged content exposed to screen readers in the viewer component | ✅ VoiceOver | ✅ TalkBack | ✅ semantic HTML |
| Semantic diff of two versions, meaning vs wording | ✅ Apple model, provider | ✅ provider | ✅ provider |
| Tools for AI agents: MCP server, WebMCP in the browser | — | — | ✅ `mcp/`, `registerWebMcpTools` |
| Automated accessibility audit in the gates (axe, Xcode, ATF) | ✅ | ✅ | ⚠️ view level only |
| Raw PDFium escape hatch | ✅ *untested* | — | — |

⚠️ iOS rendering is cancellable *between* progressive steps, which covers a slow
render. It cannot interrupt a render that hangs *inside* a single PDFium call. On iOS and
Android a watchdog makes the calls queued behind such a render fail fast with
`engineUnresponsive`, but the stuck call keeps running; on web, a `PdfWorker` can be
terminated. See Known limits.

The AI features — grounded answers and summaries — are in the separate `pdfcora-ai`
packages and are described in `docs/superpowers/specs/2026-09-13-pdfcora-ai-requirements.md`.

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
the thread doing the rendering, permanently. The call that hit it never returns.

This is PDFium behaviour, not a binding bug; it reproduces with raw `FPDF_*` calls.

#### What the SDK does about it

Every PDFium call in the process runs on one engine thread, because PDFium's global
state is not thread-safe (two documents calling it at once crashed the process). So a
hang would block every document, not just the one that hit it.

A watchdog prevents that. When one call outlives the engine timeout, the calls queued
behind it fail fast instead of waiting forever:

| | timeout setting | behind a hung call | the hung call |
|---|---|---|---|
| iOS | `PdfDocument.engineTimeout` (30 s) | throw `PdfError.engineUnresponsive` | never returns |
| Android | `PdfDocument.engineTimeoutMillis` (30 s) | throw `PdfError.EngineUnresponsive` | never returns |
| Web, `PdfWorker` | `callTimeoutMs` (30 s) | reject with `engineUnresponsive` | rejects too; the worker is terminated |
| Web, in process | — | the tab freezes | — |

On iOS and Android the stuck thread cannot be killed, so it spins a core until the
process exits, and the engine stays unresponsive for as long as the call is stuck. If
the call ever returns, the engine takes work again. Unrelated app work is unaffected.
`BlastRadiusTests` / `BlastRadiusTest` measure this against the hanging document.

**What to do in an app:** treat `engineUnresponsive` as "PDF features are unavailable
until restart", and render untrusted documents on the web through `PdfWorker`, where a
new worker recovers fully.

### Web: run untrusted documents in a Worker

`PdfWorker` runs the whole SDK inside a Worker and exposes the *same* document and page
API, so calling code is unchanged. What you gain is `terminate()`, which is the only way
to recover from the hang above.

```ts
import { PdfWorker } from '@pdfcora/web'

const worker = new PdfWorker({
  workerUrl: new URL('./pdfium-worker.js', import.meta.url),
  glueUrl:   new URL('./vendor/pdfium.esm.js', import.meta.url),
  wasmUrl:   new URL('./vendor/pdfium.esm.wasm', import.meta.url),
})

const doc  = await worker.open(bytes)
const page = await doc.page(0)
const img  = await page.render({ width: 1200 })   // identical to the in-process API

// A call that does not come back within callTimeoutMs terminates the worker and rejects
// pending calls with 'engineUnresponsive'. You can also give up sooner yourself:
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

## Redaction suggestions

`pdfcora-ai` suggests personal data to redact. Patterns find IBANs, emails, phone numbers,
payment cards, dates, URLs and IP addresses on every device; Apple's on-device model or your
custom provider adds names, postal addresses, dates of birth and ID numbers. Nothing changes
until the user accepts, and **suggestions may be incomplete: a person must still review the
whole document.**

```ts
const review = await new PdfAI(document, { provider }).redactions.suggest();
await PdfViewerElement.mount(element, document, {
  review: {
    marks: review.suggestions.map((s) => ({ id: s.id, pageIndex: s.pageIndex, rects: s.rects, state: 'pending' })),
    notice: review.notice,
    onApply: async (ids) => {
      const applied = await review.apply(ids);   // redacts; applied.undo() reopens the document as it was
    },
  },
});
```

SwiftUI (`PdfViewerView(document:review:)`) and Compose (`PdfViewerView(document, review = …)`)
take the same review setup. Save with the full save mode afterwards.

## Smart form filling

`pdfcora-ai` proposes values for a form's fields from a profile your app passes in (given and
family name, date of birth, email, phone, street, postal code, city, country, IBAN, company).
A synonym list in English and German matches each field by its tooltip, the label printed next
to it, or its name, on every device; your custom provider, if configured, matches what the list
cannot. Values are formatted for the field — a date to the field's `(TT.MM.JJJJ)` hint, a country
to one of a combo box's options — and nothing is written until the user accepts. The profile is
never stored.

```ts
const proposals = await new PdfAI(document, { provider }).forms.propose(profile);
// Show proposals.items as marks with label = the value, as for redaction; then:
const applied = await proposals.apply(acceptedIds);   // applied.undo() reopens the document as it was
```

Apple's on-device model is not used for matching fields: measured, it assigned fields in list
order rather than by meaning.

## Alt text

`page.structure()` reads a tagged PDF's structure tree (types, alt text, marked-content ids,
bounds), and `document.updateFigures(edits)` writes alternate text for figures, or marks them
decorative, into a new document: descriptions as `/Alt` in an incremental update, decorative
figures re-marked as artifacts in the content and removed from the tree. The original document
is untouched. On the shared test document the result passes veraPDF's PDF/UA-1 profile on all
three platforms (`scripts/verapdf-ua1.sh`).

`pdfcora-ai` lists the figures that have no alternate text and proposes a description for
each, or decorative for a figure too thin or small to carry information. Descriptions need an
image model: your custom provider on iOS and the web (Apple's on-device model takes no images),
ML Kit's on-device image description (English, beta) and then the provider on Android.

```ts
const review = await new PdfAI(document, { provider }).altText.suggest();
// review.untagged: the document needs tags first. Show review.items as labelled marks; then:
const updated = await review.apply([{ id, text: 'edited description' }, { id: otherId }]);
```

Role-mapped figure types are not found, because PDFium does not expose `/RoleMap`.

## Remediation

For an untagged document, `pdfcora-ai` proposes headings, paragraphs, list items, figures and
artifacts in reading order, from rules on the page objects (font sizes, line spacing, list
markers), with the same result on every platform and no model. `document.tagContent(blocks)`
in the core writes what the user confirms as a structure tree, with the content marked, `/Lang`,
`/MarkInfo` and PDF/UA metadata, into a new document. Describe its figures with the alt text
feature afterwards. On the shared test document the result passes veraPDF's PDF/UA-1 profile on
all three platforms.

```ts
const review = await new PdfAI(document).remediation.suggest();
// Show review.blocks as marks labelled "<order> <type>"; then:
const tagged = await review.apply({ language: 'en-GB', types: { [captionId]: 'P' } });
```

Tables are proposed as paragraphs, vector graphics as artifacts, and reading order follows the
content stream, so multi-column layouts may need the reviewer's attention. Annotations and form
fields are not tagged, and a document without embedded fonts cannot pass PDF/UA whatever its tags.

## Tools for AI agents

`mcp/` is an MCP server: an agent can open a PDF, read its text, search it, list its form fields and
read a page's structure, and change it only through proposals — redactions, form values, fields for
flat forms, alt text — applied with the ids the user accepted, undoable, and saved to a new file.
The same tools are available to a browser agent through WebMCP: `registerWebMcpTools(session)` from
`pdfcora-ai` registers them with `document.modelContext` where the browser has it (Chrome 152
behind `--enable-blink-features=WebMCP`). See `mcp/README.md`.

## Semantic diff

`ai.diff.compare(revised)` aligns the sentences of two versions of a document without a model
(longest common subsequence, then similarity pairing for the rest) and reports each change as
modified, added or removed, with character ranges and rectangles in both documents. A reworded
pair is labelled `meaningChanged` (with a one-sentence summary) or `wordingOnly` by Apple's
on-device model or your custom provider; without one it stays `unclassified`.

```ts
const diff = await new PdfAI(original, { provider }).diff.compare(revised);
// diff.changes: [{ kind: 'modified', label: 'meaningChanged', summary, original, revised }, …]
```

Apple's model labelled both reworded pairs of the test documents correctly in three of three runs.

## Screen readers

`page.accessibleContent()` maps a tagged page's structure tree to what a screen reader announces:
headings with their level, paragraphs, lists and list items, figures by their alternate text,
tables, and form fields by their tooltip or name, in reading order. The viewer components expose
it: the web element as visually hidden semantic HTML beside an `aria-hidden` canvas, the SwiftUI
view as VoiceOver elements (header and image traits) placed where the content is drawn, and the
Compose view as TalkBack semantics (heading, image role) placed the same way. An untagged page is
announced as one paragraph of its text; remediate it first for structure.

On the web the component also works from the keyboard: toolbar controls and review marks are
buttons with a visible focus ring, and the focused page zooms with + and − and turns with
Page Up and Page Down. On every platform the component follows the reader's text size: the web
toolbar is sized in `rem`, the SwiftUI toolbar scales with Dynamic Type, and the review bar
reflows at large text on iOS and Android.

## Fields for flat PDFs

A form printed from a word processor has blanks but no fields. `ai.forms.detect()` proposes a text
field for each underscore run, drawn line and drawn box, and a checkbox for each small square,
labelled from the text beside it, by rules and with no model. `apply` creates the accepted fields
through the core's `document.addFormFields`, in a new document, and smart form filling then works
on them.

```ts
const detected = await new PdfAI(document).forms.detect();
const withFields = await detected.apply(detected.items.map((i) => i.id));
```

## Accessibility

The viewer components are built for screen readers, keyboards and large text, and the gates run an
automated audit on each platform: axe-core's WCAG 2.1 A/AA rules on the web component, Xcode's
accessibility audit on the iOS demo, and the Accessibility Test Framework's checks on the Compose
component. `docs/accessibility/conformance-report.md` records what passes, what is not yet
evaluated, and what an independent audit still has to cover — it is a self-assessment, not a VPAT®.

## License keys

Without a license key every feature works, and rendered pages, saved files and AI output
carry a "PDFCora trial" watermark. A key unlocks the modules it lists — `editing`,
`forms`, `signing`, `redaction`, `ai` — for the app IDs and web hosts it names. Viewing,
text, search, verifying signatures, the viewer and sync need only a valid key.

```swift
PdfLicense.setKey("pk1.…")                  // iOS, before opening documents
```
```kotlin
PdfLicense.setKey(context, "pk1.…")         // Android, in Application.onCreate
```
```ts
await PdfLicense.setKey('pk1.…');           // web, before opening documents or creating a PdfWorker
```

`PdfLicense.status` says whether the key is valid, which modules it covers, and why a key
was rejected. A key never makes the SDK throw.

While a document needs the watermark it is always saved in full, even when an incremental
save is requested, and signing it rewrites the file first — so signatures already in that
file no longer verify. A licensed document keeps incremental saves and earlier signatures.

Keys are checked offline. The check deters use beyond a license; it is not copy protection.
Keys are issued with `tools/license/issue.mjs`; see `docs/superpowers/specs/2026-09-15-licensing-design.md`.

## Licensing

PDFCora is distributed as a binary that statically links PDFium and six bundled
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

- Design: `docs/superpowers/specs/2026-09-12-pdfcora-sdk-design.md`
- Foundation plan: `docs/superpowers/plans/2026-09-12-phase1-foundation.md`
