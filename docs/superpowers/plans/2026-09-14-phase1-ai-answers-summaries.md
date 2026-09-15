# pdfiumkit-ai Phase 1 — Answers and Summaries

**Goal:** grounded answers that highlight the exact sentence they came from, and
summaries of a document or page range, on iOS, Android and Web.

**Spec:** `docs/superpowers/specs/2026-09-13-pdfiumkit-ai-requirements.md` §§8, 10, 15

**Status:** built on all three platforms. Apple's on-device model has been run for real
(see "Measured against a real model"). ML Kit summarises on a real phone when called from
a foreground app, and not from the background; Chrome's summariser has not been run.

## What was checked before building on it

| Claim | Result |
| --- | --- |
| FoundationModels has guided generation, sessions and a language list | ✅ `respond(to:generating:)`, `@Generable`, `@Guide(.maximumCount)`, `SystemLanguageModel.supportedLanguages` in the Xcode 27 SDK interface |
| ML Kit GenAI Summarization exists and its API | ✅ `com.google.mlkit:genai-summarization:1.0.0-beta1`; `javap` of the AAR gave the real classes |
| ML Kit's floor | ⚠️ **minSdk 26**, the core is 23 — manifest `overrideLibrary` plus a version check on every call (PKG-3) |
| ML Kit's languages | ⚠️ **English, Japanese, Korean only** |
| ML Kit's output shapes | ⚠️ **one to three bullets**; there is no paragraph, so a paragraph request gets one bullet |
| ML Kit links against this project's Kotlin | ❌ its jar carries Kotlin 2.1 metadata; the AI module skips the metadata check rather than upgrading Kotlin project-wide |
| Core still has no AI dependency | ✅ `scripts/check-core-deps.sh` passes; ML Kit resolves only in `pdfiumkit-ai` |

## What was built

**Answers (ANS).** Each page's text is split into sentence-aligned passages with their
character ranges and ranked with BM25 on the device (ANS-1). No relevant passage returns
`notFound` without calling a model (ANS-4). The prompt carries only the passages that fit
the model's budget — Apple's `contextSize`, or `providerContextTokens` for a custom
provider — and asks for an answer plus up to three passage-id/quote citations, with a
schema on providers and `@Generable` on Apple (ANS-2, ANS-7). Each quote is looked for in
the passage it names, then in the other passages the model was shown, tolerating
whitespace and line-end hyphenation only; a citation that cannot be found is dropped and
the answer marked `grounded = false`, and a reply with no citations is `notFound` (ANS-3). Ranges
become rectangles from the core's per-character boxes, one per line (ANS-5). Pages with
no text layer are reported (ANS-6).

**Summaries (SUM).** Whole document or page range, paragraph or key points (SUM-1). Long
input is packed into parts under the summariser's limit, summarised, and combined until
one call covers everything (SUM-2). An unsupported language is
`unavailable(languageNotSupported)` when the host names the language (SUM-3).

| Route | iOS | Android | Web |
| --- | --- | --- | --- |
| Answers, on device | FoundationModels | — (prompt API is alpha) | — |
| Summaries, on device | FoundationModels | ML Kit GenAI | Chrome `Summarizer` |
| Either, fallback | custom provider | custom provider | custom provider |

`conformance/fixtures/contract.pdf` is the shared document, written by
`conformance/make-contract.mjs` by hand rather than with the SDK. The acceptance test —
"what's the notice period?" highlights §12.1 and nothing else — runs on all three
platforms, alongside a made-up quote, a wrong or unknown passage id, a real sentence the model was
not shown, and a question with no answer.

The Phase 0 stub is gone, as its own comment asked; the demos show answers and summaries.

## Measured against a real model

On 2026-09-15 the iOS simulator reached the Mac's own Apple Intelligence model (context
8,192 tokens; the first readings after launch report no budget, which the SDK already
treats as not promptable). The real `answers` and `summaries` code ran on the contract
with no provider.

First run: every answer's text was right and every quote was word for word, but only 14
of 18 were grounded. **The model gets passage ids wrong, not quotes**: it named `p1-3` for
text inside `p1-0` (it reads the id as "page 1, sentence 3") and once a heading,
`13. Payment`. Relabelling passages `P1` or `A` made it worse, 0 and 4 of 20. And an
unanswerable question came back as the answer "not mentioned in the passages" with no
citations, not the empty answer the prompt asks for.

Two changes, on all three platforms: a quote is looked for in the passage it names, then
in the other passages the model was shown, and never beyond them; and a reply with no
citations is `notFound`. After them: **30 of 30** answers grounded on the expected
sentence across six questions, and the unanswerable question `notFound` **5 of 5**. The
key-points summary was accurate, in 2.8 s. Answers took about 1.5 s each.

### ML Kit on a real phone

On 2026-09-15, a Samsung SM-F971B on Android 17 with Google AICore
(`prod_aicore_20260723`). ML Kit reports summarisation available, with base model
`nano-v4-fast`, and `prepare()` completes.

**AICore blocks inference from an app that is not in the foreground.** Every call from
the test process failed with `INFERENCE_ERROR`, code 30 — `BACKGROUND_USE_BLOCKED`, which
ML Kit `1.0.0-beta1` does not name and prints as "30-UNKNOWN". A first attempt with an
activity started from the test thread did not help, and was wrongly read as ruling the
background out. Calling from the activity's own `onResume`, with the process at
importance 100 (foreground), succeeded: a direct call summarised an article in 2.6 s, and
the SDK's `summaries.summarize()` on the contract returned accurate results from
`ON_DEVICE` — one bullet for paragraph style, three for key points.

Code 30 now surfaces as a new reason on every platform, `backgroundUseBlocked`, through a
`PdfAiUnavailableError` a route can throw to name why it failed; a later route that answers
still wins. On the phone, the SDK called from the test process returns
`BACKGROUND_USE_BLOCKED`.

Two things the phone did show, both fixed on every platform they apply to:

- **ML Kit refuses article input under 400 characters.** Text that short is no longer
  sent: the on-device route steps aside for the next one, and a short part of a longer
  document — a short page, or summaries being combined — passes through as it is.
- **A route that throws was reported as `noProvider`**, telling the integrator to
  configure something that was not missing. When a route throws and nothing else
  answers, the reason is now `requestFailed`.

## Not verified

- **Chrome's summariser has never run.** Node has no `Summarizer`. Neither has a custom
  provider been used for real.
- **ML Kit on long documents.** Only the short contract has been summarised on the phone;
  the 9,000-character part size against the model's real input limit is unmeasured.
- **One document.** The contract is short and clean; a real model on long or messy text,
  or in another language, is unmeasured.
- **ML Kit's input limit** is taken as three quarters of the documented ~4,000 tokens.
  It is not reported at runtime.
- **Characters per token** is fixed at 3 everywhere, conservative for English and
  unmeasured for German or Japanese.
- **SUM-4 streaming** and **cancellable indexing** (ANS-7's second half) are not built.
- **Language detection** is not built: SUM-3 applies only when the host passes a language.

## Decisions taken without a person

- Android answers use the custom provider only; `experimentalOnDevicePrompt` does nothing
  yet (open question 6).
- No ready-made provider adapters ship (open question 4).
- `PdfWorker` gained nothing for AI: `pdfiumkit-ai` works with the in-process document.
