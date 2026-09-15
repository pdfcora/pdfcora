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
| License keys: offline, per module, trial watermark | Done, three platforms, shared cases in `conformance/license/` |
| `pdfiumkit-ai` Phase 2a: redaction suggestions, review marks in the viewer, undo | Done, three platforms, shared cases in `conformance/redaction/` |
| `pdfiumkit-ai` Phase 2b: smart form filling from a profile, labelled marks, undo | Done, three platforms, shared cases in `conformance/forms/`; no on-device model (measured) |
| Core structure tree read; figure alt text and decorative writes | Done, three platforms; written documents pass veraPDF PDF/UA-1 (`scripts/verapdf-ua1.sh`) |
| Remediation: core `tagContent`, rule-based tag proposals (Phase 3b) | Done, three platforms, shared document in `conformance/remediation/`; output passes veraPDF PDF/UA-1 |
| Flat form detection (FORM-7) and core `addFormFields` | Done, three platforms, shared fixture `conformance/forms/flat.pdf`; rules only |
| Accessible content (A11Y-2): tagged structure exposed to VoiceOver, TalkBack, browser screen readers | Done, three platforms, UI-tested; not yet tried with a real screen reader by a person |
| `pdfiumkit-ai` semantic diff: sentence alignment, meaning vs wording labels | Done, three platforms, shared pair in `conformance/diff/`; Apple's model 3 of 3 runs right |
| `pdfiumkit-ai` Phase 3a: alt text proposals for figures in tagged PDFs | Done, three platforms, shared document in `conformance/alt-text/`; ML Kit image description route on Android not run on a real device |

Test counts at the time of writing (2026-09-15): web 300, web-ai 119 (one Ollama test skipped),
browser viewer 28, license tool 1, iOS 189 (sweep skipped) + hung-render pass + demo UI 12 + AI 73
(three Apple measurements skipped), Android 163 instrumented (sweep skipped) + UI 5 + hung-render
pass + JVM, AI JVM + 30 instrumented. pdfsig accepts both the licensed and the trial-signed
document on iOS and Android; veraPDF passes the alt text and remediation output on all three.

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

**License keys.** Keys are issued with `node tools/license/issue.mjs sign --private-key
~/.pdfiumkit-license/license-private.pem …`; that private key was generated on
2026-09-15, lives only on this Mac, and must be backed up somewhere safe — losing it means
every issued key has to be reissued against a new public key. The public key is in
`LicenseBuild` on each platform. Before each release run
`./scripts/set-release-date.sh YYYY-MM-DD`: a key covers every SDK released on or before
its expiry. Every test suite installs a test key from `conformance/license/cases.json`;
`node conformance/license/make-cases.mjs` regenerates it. The design is
`docs/superpowers/specs/2026-09-15-licensing-design.md`.

Checked in the release packages on 2026-09-15, each in a throwaway app: no key watermarks,
a key for the app renders and saves clean, a key for another app reports `wrongApp`. The
test hook is not reachable in any of them: internal on iOS (not in the interface, not
exported), refused by the release AAR (Kotlin `internal` is a public JVM method, so it is
gated on `BuildConfig.DEBUG`), and not exported by the npm package — though on web the file
is still there to import by path, which is no worse than editing the JavaScript.

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

**iOS could not sign a document PDFium had saved**, found while adding license keys. The
writer and the signer counted Swift `Character`s and used the counts as byte offsets, but
Swift joins `\r\n` into one Character, and PDFium's saves use CRLF. The trailer's
`/Root 1 0 R` misread as a number, and once that was fixed the byte range and signature
were written short of their placeholders. Offsets now count Unicode scalars, one per
Latin-1 byte. Web and Android index bytes and were never affected.

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

**Decisions, confirmed by the owner on 2026-09-15.** Android answers use the custom provider
only, and `experimentalOnDevicePrompt` does nothing yet (spec open question 6): ML Kit's
Prompt API is alpha. No provider adapters ship (question 4): apps implement the small
provider interface. The engine timeout stays 30 s on every platform.

**Review marks are small on a phone.** On a page fitted to a phone's width, a line of text is
about 7 pt tall, so a mark over it is a small target; the iOS UI test taps an IBAN mark for that
reason. Zooming in helps. A larger touch area around marks is not built.

**Alt text: what is not proven.** ML Kit's image description route is built but has not run on
a phone (the emulator has no AICore), and no real image model has described the test figures;
the tests use a fake provider. The writer finds a figure by page and marked-content ids, so a
figure without marked content, or one whose type is role-mapped to `Figure`, is not listed.
veraPDF (`scripts/install-verapdf.sh`, Java 11+) is the PDF/UA judge; CI runs it on the web
output, the local gates on the iOS and Android output.

**Checkboxes are set through PDFium's form-fill environment** (a space key on the focused widget)
since 2026-09-15. Before, `setChecked` wrote `/V` and `/AS` as strings: PDFium read them back, so
every test passed, but poppler showed the box unchecked. Only switching a radio button *off* still
writes strings, because no key does that.

**Remediation is rules only, and limited.** No model is used: the proposals are the same on
every device. Tables become paragraphs, paths become artifacts (a vector chart is not announced),
reading order is content order, and annotations and form fields are not tagged. PDF/UA has only been
checked on the hand-written test document. Over the 293 PDFium test resources (web, 2026-09-15)
remediation proposed and wrote a tree for all 234 untagged files that open, with no crash; the
only errors were the typed `corrupt` errors of pages that do not load at all.

**Android builds with Kotlin 2.1.21 and AGP 8.7.3** since 2026-09-15 (the Compose compiler is the
Kotlin plugin; the AI module no longer skips the metadata version check ML Kit's Kotlin 2.1 classes
needed). AGP 8.7 uninstalls test APKs after a run, so `scripts/test-android.sh` passes
`android.injected.androidTest.leaveApksInstalledAfterRun=true` for the cross-checks to pull files.

**Parked on 2026-09-15, to do later:** Chrome's Summarizer is untested (it needs a
multi-gigabyte model in a Chrome profile). A real custom provider
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
