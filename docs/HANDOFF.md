# Where things stand

Last updated: 2026-09-14. Everything described here is committed; `git log` is the
detailed record and each commit message explains *why*, not just what.

## The short version

The SDK is feature-complete for its stated scope on iOS, Android and Web: render, text,
search, forms, annotations, digital signatures (read/verify/sign), redaction, and a
viewer with cross-platform sync and an optional UI component.

**One known defect is still open: a PDFium threading race on iOS.** See §3.

## 1. What exists

| Area | State |
| --- | --- |
| Core SDK (render, text, search, forms, annotations) | Done, three platforms |
| Digital signatures — read, verify, sign PAdES B-T | Done, cross-checked against `pdfsig` |
| Redaction | Done, gated on the saved **bytes**, not the text layer |
| Viewer: state, scroll/zoom transfer, events, sync | Done, three platforms |
| Viewer: editing through the viewer, presenter rule | Done, three platforms |
| UI layer: component, configurable toolbar, theme | Done, three platforms, adopted by all demos |
| `pdfiumkit-ai` | **Phase 0 only** — scaffolding, no AI feature |

Test counts at the time of writing: web 244, iOS 149 (+2 skipped), Android 127
instrumented + 16 JVM unit.

## 2. Running things

```bash
cd web && npm test                       # web
./scripts/test-ios.sh                    # iOS  (simulator)
ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh
./scripts/check-core-deps.sh             # the core must gain no AI dependency
```

**Give the Android emulator 4GB.** At the default 2GB the suite is killed part-way by
the low-memory killer, and whichever test was in flight is reported as failed with an
empty message — which reads exactly like a flaky test and is not one.

```bash
emulator -avd Pixel_9 -memory 4096
```

**Set `ANDROID_SERIAL` whenever more than one device is attached.** Gradle honours it;
so does the gate now. They used to disagree, and the signing cross-check pulled the
signed document off the wrong device and blamed the signature.

## 3. Open: the iOS PDFium race

**`PdfDocument` is an actor, so each document gets its own executor and two documents
call PDFium concurrently. PDFium's global state is not thread-safe.** Android had the
same defect and is fixed; the web is single-threaded and unaffected.

What is done on iOS:

- All documents share one `EngineExecutor`, so actor isolation serialises the engine
  rather than one document.
- An actor's `init` and `deinit` run on the *caller's* thread, not the actor's executor.
  Both now hop to the engine thread.

That took the failure from every run to one test in a full suite. **It is not gone.** The
crash moves between tests, which means at least one more PDFium call escapes the engine
thread.

`ios/Tests/PdfiumKitTests/CrossDocumentStressTests.swift` reproduces it and is **skipped**
so the gate stays truthful. Unskip it to work on this.

Suggested next step: audit every PDFium call site for isolation in one pass, rather than
chasing crashes one at a time. Candidates are anything `nonisolated`, anything in an
initialiser or deinitialiser, and anything reached from a `struct` that holds a handle.

## 4. Open: decisions for a person, not bugs

**No watchdog for a wedged engine thread.** Serialising PDFium is required for
correctness, and it means one hung call blocks every document. Making that survivable
needs a watchdog that abandons a stuck thread and fails the calls queued behind it. That
is a design decision and was deliberately not improvised.

Consequence: `BlastRadiusTest` (Android) and `HangProbeTests` / `BlastRadiusTests` (iOS)
are skipped. They work by wedging a render forever, which a single engine thread never
recovers from. Re-enable them if a watchdog lands. The iOS gate's second pass existed
only for those suites and has been removed.

**`addInk` diverges across platforms.** iOS takes several strokes and builds one
annotation; web and Android take one stroke. Ink therefore syncs one stroke at a time and
a multi-stroke iOS annotation cannot be replayed faithfully. You chose to leave it;
aligning the signatures is a breaking change to two public APIs.

**`pdfiumkit-ai` Phase 1 is not started.** Grounded answers run on-device only on Apple;
Android's prompt API is alpha and the web has nothing outside desktop Chrome.

## 5. Things that will waste your time if you do not know them

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

## 6. Conformance fixtures

`conformance/view-state.json` is the cross-platform contract for the viewer: all three
platforms decode it and assert the same derived scroll offsets and edit arguments. Its
expected values were computed by **independent arithmetic**, not by running any SDK, so
agreement is evidence rather than three copies of one mistake. Keep it that way.
