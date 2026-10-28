# Where things stand

Last updated: 2026-09-15. Everything described here is committed; `git log` is the
detailed record and each commit message explains *why*, not just what.

## The name: PDFCora (formerly PdfiumKit)

Renamed on 2026-09-17, before anything was published, because PDFium is Google's project
name and its BSD-3-Clause licence forbids using it to promote derived products. "Built on
PDFium" stays as attribution; everything about the engine itself keeps its name
(`libpdfium`, `CPdfium`, `PdfiumModule`, the build scripts).

| Was | Is |
| --- | --- |
| `PdfiumKit`, `PdfiumKitUI`, `PdfiumKitAI` (Swift) | `PDFCora`, `PDFCoraUI`, `PDFCoraAI` |
| `com.pdfiumkit:pdfiumkit`, `-ui`, `-ai` | `com.pdfcora:pdfcora`, `pdfcora-ui`, `pdfcora-ai` |
| `@pdfiumkit/web`, `@pdfiumkit/node`, `pdfiumkit-ai`, `pdfiumkit-mcp` | `@pdfcora/web`, `@pdfcora/node`, `@pdfcora/web-ai`, `pdfcora-mcp` |
| `PdfiumAI`, `PdfiumAIOptions` | `PdfAI`, `PdfAIOptions` — a Swift type cannot share its module's name |
| `PDFIUMKIT_*` environment variables | `PDFCORA_*` |

Not renamed, on purpose, because they are real things outside the code: this repository's
folder and GitHub name (`PdfiumKit-v2`), and the PDFium build tree at
`/Users/daos/Projects/Lab/pdfiumkit`.
The test signing identity and the test TSA certificate were regenerated as "PDFCora Test
Signer" / "PDFCora Test TSA" with the password `pdfcora`; nothing committed was signed with
the old ones. The iOS modules now carry `.docc` catalogs, so DocC names its pages
`com.pdfcora.*` instead of taking the identity from the folder name.

## The short version

The SDK is feature-complete for its stated scope on iOS, Android and Web: render, text,
search, forms, annotations, digital signatures (read/verify/sign), redaction, and a
viewer with cross-platform sync and an optional UI component.

`pdfcora-ai` Phase 1 — grounded answers and summaries — is built on all three platforms
and has run against real models on Apple and on an Android phone; Chrome's has not.

Small per-feature samples live in `samples/`: core, AI and UI for iOS, Android and web,
plus agents (MCP and WebMCP) for Node and the browser. `samples/README.md` is the index.

No known defects are open. §3 records what was fixed on 2026-09-14 and 2026-09-15,
because each lesson generalises. §4 lists what is open and what was parked.

## 1. What exists

| Area | State |
| --- | --- |
| Core SDK (render, text, search, forms, annotations) | Done, three platforms |
| Digital signatures — read, verify, sign PAdES B-T | Done, cross-checked against `pdfsig` |
| Redaction | Done, gated on the saved **bytes**, not the text layer |
| Viewer: state, scroll/zoom transfer, events, sync | Done, three platforms |
| Viewer: editing through the viewer, presenter rule | Done, three platforms |
| UI layer: component, configurable toolbar, theme | Done, three platforms, adopted by all demos |
| Engine watchdog: calls behind a hung PDFium call fail fast | Done, three platforms |
| `pdfcora-ai` Phase 1: grounded answers, summaries | Built, three platforms; real-model tested on Apple and on an Android phone |
| Samples: one small app per feature area (core, AI, UI, agents) | iOS, Android, web — `samples/` |
| Node SDK (`@pdfcora/node`) | Done — a thin layer over the web package: whole API re-exported, plus file, PNG and env-key helpers |
| Java SDK (`com.pdfcora:pdfcora-java`) | Core, annotations, form filling, redaction, tagging (veraPDF-validated), signatures (read, verify, sign), viewer state — over JNI on macOS and Linux. No timestamping, no AI |
| `pdfcora-ai` Phase 2a: redaction suggestions, review marks in the viewer, undo | Done, three platforms, shared cases in `conformance/redaction/` |
| `pdfcora-ai` Phase 2b: smart form filling from a profile, labelled marks, undo | Done, three platforms, shared cases in `conformance/forms/`; no on-device model (measured) |
| Core structure tree read; figure alt text and decorative writes | Done, three platforms; written documents pass veraPDF PDF/UA-1 (`scripts/verapdf-ua1.sh`) |
| Remediation: core `tagContent`, rule-based tag proposals (Phase 3b) | Done, three platforms, shared document in `conformance/remediation/`; output passes veraPDF PDF/UA-1 |
| Flat form detection (FORM-7) and core `addFormFields` | Done, three platforms, shared fixture `conformance/forms/flat.pdf`; rules only |
| Agent tools: MCP server (`mcp/`) and WebMCP registration | Done; read tools plus proposal/apply/undo, saving only to a new file; WebMCP checked in Chrome 152 behind a flag |
| Automated accessibility audits in the gates (A11Y-1) | Done, three platforms; draft report in `docs/accessibility/conformance-report.md`. A11Y-4 still needs an independent audit |
| Accessible content (A11Y-2): tagged structure exposed to VoiceOver, TalkBack, browser screen readers | Done, three platforms, UI-tested; not yet tried with a real screen reader by a person |
| `pdfcora-ai` semantic diff: sentence alignment, meaning vs wording labels | Done, three platforms, shared pair in `conformance/diff/`; Apple's model 3 of 3 runs right |
| `pdfcora-ai` Phase 3a: alt text proposals for figures in tagged PDFs | Done, three platforms, shared document in `conformance/alt-text/`; ML Kit image description measured on a Samsung SM-F971B on 2026-09-16 |

Test counts at the time of writing (2026-09-16): web 303, web-ai 128 (one Ollama test skipped),
browser viewer 36 (includes the axe audit and WebMCP), MCP server 3, iOS 191 (sweep
skipped) + hung-render pass + demo UI 14 + AI 75 (three Apple measurements skipped), Android 165
instrumented (sweep skipped) + UI 7 + hung-render pass + JVM, AI JVM + 32 instrumented, Node 7,
Java 50. pdfsig accepts the signed document on iOS, Android and the Java SDK; veraPDF passes the alt text and remediation output on all three, and the Java
SDK's tagged output.

## 2. Running things

```bash
cd web && npm test                       # web
cd web-ai && npm test                    # web AI
./scripts/test-web-browser.sh            # web viewer component in headless Chrome
./scripts/test-ios.sh                    # iOS  (simulator)
ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh
./scripts/check-core-deps.sh             # the core must gain no AI dependency
```

**CI on GitHub** runs web, web-ai, conformance, core-deps, the Android JVM tests and build,
and the iOS SDK and AI suites. The Android emulator suite and the iOS demo UI tests stay
local (the gates above). The PDFium binaries come from the release `vendor-chromium-7243`,
downloaded by `.github/actions/fetch-vendor`; a new PDFium build needs a new release
archive in the layout `scripts/fetch-vendor.sh` reads (`out/…` and `src-android/…`).

**Give the Android emulator 4GB.** At the default 2GB the suite is killed part-way by
the low-memory killer, and whichever test was in flight is reported as failed with an
empty message — which reads exactly like a flaky test and is not one.

```bash
emulator -avd Pixel_9 -memory 4096 -no-window -gpu swiftshader_indirect -crash-report-mode never
```

The extra flags are from a bad evening on a loaded Mac: a windowed emulator repeatedly
stopped answering `adb shell` while still listed as `device`, Gradle then read its API
level as 1 and refused to install, and a crashed emulator's relaunch sat on an invisible
crash-report consent dialog. Headless with software GPU stayed responsive.

**Releasing.** The source stays in this private repository; only packages and samples
are public. In order:

```bash
./scripts/publish-npm.sh [--publish]        # @pdfcora/web, web-ai, node, pdfcora-mcp
./scripts/publish-maven.sh [--upload]       # com.pdfcora:pdfcora, -ui, -ai, pdfcora-java
./scripts/package-swift.sh                  # build/swift: 3 xcframework zips + repo/
./scripts/export-samples.sh                 # build/samples-public
```

- npm needs `npm login` as a member of the `@pdfcora` organisation.
- Maven Central needs the `com.pdfcora` namespace verified on central.sonatype.com,
  `PDFCORA_SIGNING_KEY`/`PDFCORA_SIGNING_PASSWORD` (a PGP key whose public half is on
  keys.openpgp.org) and `PDFCORA_CENTRAL_TOKEN`. The upload is user-managed: press
  Publish in the portal.
- iOS: push `build/swift/repo` to github.com/pdfcora/pdfcora-swift, tag it with the
  version, and attach the three zips to that tag's release. The checksums in
  `Package.swift` are for those exact zips, so rebuild and re-upload together.
- Samples: `.github/workflows/samples-sync.yml` pushes the export to
  github.com/pdfcora/samples once the `SAMPLES_DEPLOY_KEY` secret is set; set it only
  after the packages above are live.

Published artifacts carry no source: the Maven sources jars hold a README only, and the
Swift frameworks ship public interfaces only. The npm packages are compiled JavaScript,
which is readable. `build/samples-public` was checked against the local packages on
2026-09-17: Node and Java samples run, Android samples run on the emulator, iOS samples
build and launch on the simulator.

**Set `ANDROID_SERIAL` whenever more than one device is attached.** Gradle honours it;
so does the gate now. They used to disagree, and the signing cross-check pulled the
signed document off the wrong device and blamed the signature.

## 3. Fixed

**The iOS PDFium crash was a use-after-free, not a race.** `PdfDocument.deinit` queues the
frees onto the engine thread, and the actor's memory is released before that job runs.
`FPDF_FORMFILLINFO` lived inline in the actor, and PDFium's form destructor calls
`info->Release` through it. It now lives on the heap and is freed after the handles.
`CrossDocumentStressTests` runs again, with a test that reproduces the crash every time
(the filler must be Swift objects in the actor's size class: `MallocScribble` and raw
buffers never reach the slot).

**The web build lost form edits after any form document was closed.** Form handles were
cached by document handle and never released; the next document reused the freed
address and inherited a form environment bound to freed memory. 37 of 40 edits vanished
from the saved bytes in a probe. The document now owns and releases its form handle.

**Android reported the wrong open error under concurrency.** `FPDF_GetLastError` was read
in a second engine hop, so another document's failure could overwrite it.

**A hung PDFium call no longer blocks every document.** See `EngineExecutor` on iOS and
Android: work is fed to the engine thread one item at a time under
`PdfDocument.engineTimeout` (30 s); when an item outlives it, everything behind it throws
`engineUnresponsive`, and the engine takes work again if the stuck call returns. The stuck
call itself cannot be interrupted. `PdfWorker` on the web terminates a worker that answers
nothing for `callTimeoutMs`. `BlastRadiusTests` run against the real hanging document, in
their own process.

**`addInk` takes several strokes everywhere**, and the `inkAdded` event carries `strokes`.
Breaking for web and Android and for the sync wire, accepted pre-release.

On 2026-09-15, found by running the samples and real models:

**The viewer page was blurry on iOS, and the web lacked high-density rendering.**
`PdfViewer.render` took no screen scale, so a 3x iPhone upscaled a 1x bitmap. It now takes
`scale:` (iOS) or `pixelRatio` (web), and the components pass the display's. Android
already rendered in pixels.

**Viewer components hid or crashed on an open error.** Android's `PdfViewerView` let the
error escape and crash the app; iOS's swallowed it behind an endless spinner. Both now
show it. That exposed iOS `page(_:)` throwing "out of range (document has 0)" for a closed
document instead of `closed`.

**AI, against real models.** Apple's model quotes accurately but misnames passage ids, so
a quote is now matched in any passage the model was shown; a reply with no citations is
`notFound`. A failing route reports `requestFailed`, or `backgroundUseBlocked` when AICore
refuses a background app. ML Kit's limits are 400 to 7,860 characters per call. Long
documents are summarised in windows that carry the summary so far.

**iOS could not sign a document PDFium had saved**. The
writer and the signer counted Swift `Character`s and used the counts as byte offsets, but
Swift joins `\r\n` into one Character, and PDFium's saves use CRLF. The trailer's
`/Root 1 0 R` misread as a number, and once that was fixed the byte range and signature
were written short of their placeholders. Offsets now count Unicode scalars, one per
Latin-1 byte. Web and Android index bytes and were never affected.

## 4. Open

**`pdfcora-ai` on real models.** The iOS simulator reaches the Mac's
own Apple Intelligence model, and on the contract it grounds 30 of 30 answers — after two
fixes the real model forced (it misnames passage ids, and says "not mentioned" instead of
replying empty). ML Kit GenAI summarises accurately on a real phone (Samsung SM-F971B, Android 17) — but
**only from a foreground app**: AICore returns code 30, `BACKGROUND_USE_BLOCKED`, otherwise,
and ML Kit beta1 prints that as "30-UNKNOWN". The SDK reports it as
`BACKGROUND_USE_BLOCKED`. Test processes count as background; probe from a resumed activity. Chrome's Summarizer ran in Chrome 152
(see below).
`docs/superpowers/plans/2026-09-14-phase1-ai-answers-summaries.md` lists the other
unmeasured numbers (ML Kit's input limit, characters per token) and what is not built
(streaming, cancellable indexing, language detection).

**Decisions, confirmed by the owner on 2026-09-15.** Android answers use the custom provider
only, and `experimentalOnDevicePrompt` does nothing yet (spec open question 6): ML Kit's
Prompt API is alpha. No provider adapters ship (question 4): apps implement the small
provider interface. The engine timeout stays 30 s on every platform.

**Review marks are small on a phone.** On a page fitted to a phone's width, a line of text is
about 7 pt tall, so a mark over it is a small target; the iOS UI test taps an IBAN mark for that
reason. Zooming in helps. A larger touch area around marks is not built.

**Alt text: what is not proven.** ML Kit's image description route ran on a Samsung SM-F971B on
2026-09-16 and described both figures of `conformance/alt-text/tagged.pdf` accurately in 4.6 s
(see the measurements in `docs/superpowers/plans/2026-09-14-phase1-ai-answers-summaries.md`); it
needs the screen on, not merely a resumed activity. No custom provider has described a figure for
real; those tests use a fake. The writer finds a figure by page and marked-content ids, so a
figure without marked content, or one whose type is role-mapped to `Figure`, is not listed.
veraPDF (`scripts/install-verapdf.sh`, Java 11+) is the PDF/UA judge; CI runs it on the web
output, the local gates on the iOS and Android output.

**Checkboxes are set through PDFium's form-fill environment** (a space key on the focused widget)
since 2026-09-15. Before, `setChecked` wrote `/V` and `/AS` as strings: PDFium read them back, so
every test passed, but poppler showed the box unchecked. Only switching a radio button *off* still
writes strings, because no key does that.

**Compose's test framework, from 1.8 on, cannot scroll here — and it is not our code.** Settled on
2026-09-16. Under BOM 2025.06.01 (Compose 1.8.3) and 2025.09.01 (1.9.2), the first `performScrollTo`
that actually scrolls never returns: Compose never reports itself idle, the main looper parks with
no work, and ActivityManager kills the process after about 40 s, which Gradle reports as
"Process crashed". A thread dump puts the test thread in `Espresso.onIdle` under
`ComposeUiTest.waitForIdle`, so nothing of ours is on the stack. It reproduces with a bare
`Column { scrollable Row of IconButtons; Box }` — no PDFCora code — and is unchanged by the
Android version (36 and 35), the Espresso version (3.7.0; 3.6.1 cannot run on Android 16 at all,
because it calls the removed `InputManager.getInstance`), disabling the 1.8 overscroll effect, or
`kotlinx-coroutines-test` 1.8.1 against 1.10.2. Compose 1.6 (BOM 2024.06.00) with Espresso 3.7.0 is
therefore what the module stays on; Compose 1.12 would need AGP 9.1 as well.

**Android's node-level accessibility checks are in the gates** since 2026-09-16, without that
upgrade: `PdfViewerViewTest` runs the Accessibility Test Framework's LATEST preset over the
accessibility tree the platform gives a screen reader (`UiAutomation.rootInActiveWindow`), which
contains Compose's virtual nodes. The test asserts the tree really is the composition's (toolbar
ids, the figure descriptions, the review mark) so it cannot silently degrade to checking a bare
host view, and removing a figure's fallback description makes it fail on the two unlabelled images
— the same defect Compose 1.8's own checks found.

**The Java SDK is a fourth implementation**, and now covers the core plus annotations,
form filling, redaction, tagging, signatures — reading, verifying and creating — and the
viewer state layer. `scripts/test-java.sh` puts both write paths in front of outside
judges: veraPDF for the tagged document's PDF/UA-1 claim, and poppler's `pdfsig` for the
signed one, which reports *Signature is Valid, Total document signed*.

What it does *not* have: **RFC 3161 timestamping** (a signature is PAdES B-B, not B-T), **the AI package**, and no
Windows engine.

Worth knowing for anyone extending it. The byte-level writer here is smaller than the
web's: it reads objects by scanning for `N 0 obj` rather than parsing the cross-reference
table, which works because tagging always runs on a PDFium full save, where every object
is written plainly. A file whose objects live in object streams is refused with a clear
error instead of being half-written. PDFium also re-saves and normalises whatever this
writes — `/Lang(en)` for `/Lang (en)` — so tests that inspect the bytes allow either
spacing, and marked content is only visible after inflating the content stream. It uses JNI rather than the Foreign Function API so it runs on
Java 17; FFM would need 22+, and JDK 21 only offers it as a preview. The native library is
built by `scripts/build-jni.sh` from `vendor/desktop`, which means the Java SDK depends on
the desktop engines, and those are optional artifacts. macOS and Linux only: there is no
Windows engine build. Every feature added to it is a feature to add four times, which is
the cost to weigh before extending it.

**The Node SDK is not a fourth implementation**, deliberately. `@pdfcora/node` re-exports
`@pdfcora/web` — a test asserts every export is present — and adds only `openFile`,
`saveFile`, `renderPng`, `renderRaw` and `useLicenseFromEnvironment`. The engine is the same
WebAssembly build. What a server does not get from it is `PdfWorker`: containing a stalled
page needs a `worker_thread` or a child process.

**Remediation is rules only, and limited.** No model is used: the proposals are the same on
every device. Tables become paragraphs, paths become artifacts (a vector chart is not announced),
reading order is content order, and annotations and form fields are not tagged. Over the 293 PDFium
test resources (web, 2026-09-15) remediation proposed and wrote a tree for all 234 untagged files
that open, with no crash; the only errors were the typed `corrupt` errors of pages that do not load.

**Measured against 238 real documents on 2026-09-16** — see
`docs/accessibility/remediation-real-world.md`, reproduced with
`scripts/fetch-real-world-corpus.sh` and `scripts/remediation-survey.mjs`. Nothing crashed and
nothing was slow (762,178 blocks over 6,146 pages in 31 s). 61 documents were already tagged and
correctly refused; 13 were refused with typed errors (9 encrypted, 4 with a broken xref); 4 were
scans with no text layer. Of the 160 remediated, 9 came out PDF/UA-1 compliant and 129 of the rest
fail only on figures needing alt text, untagged annotations, or fonts the source never embedded —
which tagging cannot fix. The remaining 22 are the work list; the largest group, 12 documents
failing 7.1-1/7.1-2, is a nesting bug: the page's content stream already holds marked content and
tagging adds its own marks around it. `FPDFPageObj_GetMarkedContentID` reports the existing id, so
the fix is to notice it before marking.

The survey found a defect that is **fixed** on all three platforms: heading levels came from font
size alone, so a document whose largest line was not its first heading started below H1 and skipped
levels (7.4.2).

**Android builds with Kotlin 2.1.21 and AGP 8.7.3** since 2026-09-15 (the Compose compiler is the
Kotlin plugin; the AI module no longer skips the metadata version check ML Kit's Kotlin 2.1 classes
needed). AGP 8.7 uninstalls test APKs after a run, so `scripts/test-android.sh` passes
`android.injected.androidTest.leaveApksInstalledAfterRun=true` for the cross-checks to pull files.

**Chrome's Summarizer has run for real** (2026-09-15, Chrome 152): summaries on the contract and a
German page are grounded, and a quota bug it exposed is fixed. `node web-ai/scripts/measure-chrome-summarizer.mjs`
reruns it (the model stays in `~/.cache/pdfcora/chrome-ai-profile`). A real custom provider
has run: Llama 3.2 3B through Ollama grounds 25 of 30 answers (`web-ai/test/ollama.test.ts`).

**The code is on GitHub** at `github.com/indaos/PdfiumKit-v2`, a **private** repository,
first pushed on 2026-09-15. Keep it private: the SDK's source includes the license check.

**The PDFium corpus sweep** (293 test resources) runs on all three platforms:
`node conformance/robustness.mjs`, `scripts/sweep-ios.sh`, and
`ANDROID_SERIAL=<device> scripts/sweep-android.sh`. On 2026-09-15 all three agreed file by
file: 265 ok, 23 rejected, 4 typed errors, no crashes, no untyped throws, and one timeout
(`bug_451265.pdf`). Its page draws a form whose tiling pattern draws the same form again;
rendering hangs at every size while text extraction returns at once. PDFium added the file
in 2015 as a stack-exhaustion case and never tests it automatically, so this is PDFium's
behaviour, and the watchdog is the SDK's answer to it. The native sweeps are not part of
the gates; their tests skip without a corpus.

**Not yet tested:** the iOS
viewer component is tested only end to end through the demo app's UI tests, which the iOS
gate runs.

## 5. Things that will waste your time if you do not know them

- **Anything PDFium keeps a pointer to must not be stored inline in an actor** whose
  `deinit` defers the frees. The actor's memory is gone before the deferred job runs.
- **A freed PDFium handle is a reused address.** Never key state on a handle that
  outlives `close()`; the web form bug was exactly that.
- **On the rescue queue, code runs beside the stuck call.** Anything reached from an
  engine job must pass `requireHandle()` / `ensureResponsive()` before touching PDFium.
- **`withoutActuallyEscaping` traps if the closure is still retained when the block
  ends**, even for a moment on another queue. `EngineExecutor.run` crashed that way once.
- **iOS PDF saves are not byte-deterministic.** PDFium regenerates the trailer `/ID` on
  every save on Apple platforms; the web build does not. Comparisons blank that field.
- **A round-trip test cannot catch a symmetric error.** Dividing the viewport by three in
  *both* scroll conversions still inverts correctly. There is a hand-computed absolute
  assertion for that reason.
- **Rotation crosses the wire as degrees.** iOS and Android hold PDFium's quarter-turn
  index 0–3; the web holds degrees. Fixture cases using rotation 0 cannot catch a
  platform getting this wrong, which is why there is a 90° case.
- **The corpus pages are 200×200**, smaller than any realistic viewport. A scroll test
  that does not first assert the content overflows is asserting nothing.
- **A toolbar of fixed-width items overflows rather than wrapping**, and the platform
  silently clips the overflow. UI tests assert *hittability*, not existence.
- **Reading `androidTest-results/` without clearing it first** can report a previous
  run's results as the current one's.
- **The toolbars scroll sideways; they do not clip.** An icon cut off at the right edge is
  the edge of a scrollable row, not a bug.
- **Compose UI tests on the Android 16 emulator** need Espresso 3.7 (older ones call a
  removed `InputManager` method) and a test `targetSdk` (otherwise a warning dialog covers
  the composition).
- **AICore code 30 is `BACKGROUND_USE_BLOCKED`.** A test process is background; call ML Kit
  from a resumed activity. A locked or dozing phone makes every activity background too.
- **The iOS simulator reaches the Mac's Apple Intelligence model**, with an 8,192-token
  context, after about a second of reporting no budget.
- **Headless Chrome `--screenshot` writes the file but may never exit**; poll for the file
  and kill the process.

## 6. Conformance fixtures

`conformance/view-state.json` is the cross-platform contract for the viewer: all three
platforms decode it and assert the same derived scroll offsets and edit arguments. Its
expected values were computed by **independent arithmetic**, not by running any SDK, so
agreement is evidence rather than three copies of one mistake. Keep it that way.

`conformance/fixtures/contract.pdf` is the document grounded answers are tested on. It is
written by `conformance/make-contract.mjs` by hand, not by the SDK, for the same reason.
