# Where things stand

Last updated: 2026-09-14. Everything described here is committed; `git log` is the
detailed record and each commit message explains *why*, not just what.

## The short version

The SDK is feature-complete for its stated scope on iOS, Android and Web: render, text,
search, forms, annotations, digital signatures (read/verify/sign), redaction, and a
viewer with cross-platform sync and an optional UI component.

No known defects are open. §3 records the iOS PDFium crash that was, because the lesson
generalises.

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

Test counts at the time of writing: web 244, iOS 152, Android 127
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

## 3. Fixed: the iOS PDFium crash

**It was a use-after-free, not a race.** `PdfDocument.deinit` queues the PDFium frees onto
the engine thread, and the actor's memory is released before that job runs. The
`FPDF_FORMFILLINFO` was stored inline in the actor, and PDFium's form environment
destructor calls `info->Release` through it. Freed memory reused by another allocation
turned that into a jump to garbage — `SIGBUS` in `FPDFDOC_ExitFormFillEnvironment`, on the
engine queue, which is why it looked like a thread race and moved between tests.

The form info now lives on the heap and the deinit job frees it after the handles; the job
also holds the document bytes, which PDFium requires to outlive the handle.

Serialisation was still needed and stays: all documents share one `EngineExecutor`, and
`init`/`deinit` hop to it. The rest of the audit found no PDFium call off that thread —
`init`'s error path (`FPDF_GetLastError`, a plain global) was checked and already runs on
it.

`CrossDocumentStressTests` runs again. Its
`testFreeingADroppedDocumentDoesNotReadItsReleasedMemory` reproduces the crash every time
by holding the engine, dropping documents, and filling the freed slots. Two things it
needed, both learned the hard way: `MallocScribble` and raw byte buffers do not reach the
slot, because the allocator buckets them separately from Swift objects; and the filler must
be in the actor's exact size class.

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

- **Anything PDFium keeps a pointer to must not be stored inline in an actor** whose
  `deinit` defers the frees. The actor's memory is gone before the deferred job runs.
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
