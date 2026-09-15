# Where things stand

Last updated: 2026-09-15. Everything described here is committed; `git log` is the
detailed record and each commit message explains *why*, not just what.

## The short version

The SDK is feature-complete for its stated scope on iOS, Android and Web: render, text,
search, forms, annotations, digital signatures (read/verify/sign), redaction, and a
viewer with cross-platform sync and an optional UI component.

`pdfiumkit-ai` Phase 1 — grounded answers and summaries — is built on all three platforms
and has run against real models on Apple and on an Android phone; Chrome's has not.

Minimal integration samples live in `samples/basic-{ios,android,web}`.

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
| `pdfiumkit-ai` Phase 1: grounded answers, summaries | Built, three platforms; real-model tested on Apple and on an Android phone |
| Basic samples: one screen, bundled PDF in the viewer component | iOS, Android, web — `samples/` |

Test counts at the time of writing: web 248, web-ai 41, iOS 158 + hung-render pass + AI
42, Android 133 instrumented + UI 1 + hung-render pass + 16 JVM, AI 27 JVM + 9
instrumented.

## 2. Running things

```bash
cd web && npm test                       # web
cd web-ai && npm test                    # web AI
./scripts/test-ios.sh                    # iOS  (simulator)
ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh
./scripts/check-core-deps.sh             # the core must gain no AI dependency
```

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

On 2026-09-15, found by running the basic samples and real models:

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

## 4. Open

**`pdfiumkit-ai` has not run on Chrome.** The iOS simulator reaches the Mac's
own Apple Intelligence model, and on the contract it grounds 30 of 30 answers — after two
fixes the real model forced (it misnames passage ids, and says "not mentioned" instead of
replying empty). ML Kit GenAI summarises accurately on a real phone (Samsung SM-F971B, Android 17) — but
**only from a foreground app**: AICore returns code 30, `BACKGROUND_USE_BLOCKED`, otherwise,
and ML Kit beta1 prints that as "30-UNKNOWN". The SDK reports it as
`BACKGROUND_USE_BLOCKED`. Test processes count as background; probe from a resumed activity. Chrome's Summarizer needs desktop Chrome and has
not run.
`docs/superpowers/plans/2026-09-14-phase1-ai-answers-summaries.md` lists the other
unmeasured numbers (ML Kit's input limit, characters per token) and what is not built
(streaming, cancellable indexing, language detection).

**Decisions taken without you, to revisit.** Android answers use the custom provider only,
and `experimentalOnDevicePrompt` does nothing yet (spec open question 6). No provider
adapters ship (question 4). The engine timeout defaults to 30 s on every platform.

**The Android AI module skips Kotlin's metadata version check**, because ML Kit ships
Kotlin 2.1 metadata and the project builds with 1.9. Upgrading Kotlin removes the need.

**Parked on 2026-09-15, to do later:** Apple's model returns window summaries with "- - "
bullets; Chrome's Summarizer and a real custom provider are untested (each needs a
multi-gigabyte download); the three decisions above; the Kotlin upgrade; and the commits
have never been pushed — **the repository has no remote**.

**Not yet tested:** iOS `PdfiumKitUI` has no test target, and the PDFium corpus sweep has
only run through the web build.

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
