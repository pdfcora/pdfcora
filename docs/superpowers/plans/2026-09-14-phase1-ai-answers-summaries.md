# pdfiumkit-ai Phase 1 — Answers and Summaries

**Goal:** grounded answers that highlight the exact sentence they came from, and
summaries of a document or page range, on iOS, Android and Web.

**Spec:** `docs/superpowers/specs/2026-09-13-pdfiumkit-ai-requirements.md` §§8, 10, 15

**Status:** built on all three platforms. Apple's on-device model has been run for real
(see "Measured against a real model"). ML Kit summarises and describes images on a real phone
when called from a foreground app with the screen on, and not otherwise; Chrome's summariser has
been run for real.

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
input is read in windows (SUM-2): the first window is plain text, and each later one
carries the summary so far plus the next stretch of text, so the last summary covers the
whole document and each part is summarised knowing what came before. A summary that would
crowd out the text is condensed first. This replaced summarising parts separately and then
combining their summaries. An unsupported language is
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

### A custom provider: Llama 3.2 3B through Ollama

On 2026-09-15, `llama3.2:3b` in Ollama 0.32 on the Mac, behind the custom provider interface
(`web-ai/test/ollama.test.ts`, opt-in with `OLLAMA_MODEL`; the provider is 20 lines, with the
answer schema passed as Ollama's `format`). **25 of 30** answers grounded on the expected
sentence across six questions, and the unanswerable question `notFound` **5 of 5**, at 0.6
to 1.4 s an answer. All five misses were one question, "Who are the parties?": the answer
text was right but the model cited two other sentences, so the SDK reported
`grounded: false` — which is the point of verifying quotes. Both summaries were accurate;
the key-points one opened with a line of preamble before the bullets.

It also cited one sentence three times in a reply, and the SDK returned three identical
citations. A repeated citation now counts as verified but is kept once, on all three
platforms.

### Redaction suggestions with Apple's model

On 2026-09-15, through the iOS simulator (`RedactionMeasurementTests`, opt-in with
`TEST_RUNNER_PDFIUMKIT_MEASURE_APPLE=1`), on `conformance/redaction/pii.pdf` with only the
model categories asked for: the English page **3 of 3** (a person's name, a postal address,
a passport number) in 2.7 s, the German page **4 of 4** (a name, an address, an ID card
number and a tax ID) in 2.6 s. It also returned each date of birth, and every name at both of
its occurrences. Its ID quotes are wider than the numbers: "Passport number 502135326", and
the two German IDs in one quote with their labels, so those redactions take a few extra
words. The first readings after launch report no prompt budget, so a first call can fall back
to patterns; the measurement warms the model up with one call.

### Form field matching with Apple's model

On 2026-09-15, through the iOS simulator (`FormMeasurementTests`), on
`conformance/forms/forms.pdf` with every label removed so the model had only field names and
tooltips, over four runs: the English page between 1 and 7 of 13 right, the German page between
2 and 7 of 12. The errors are not near misses. It assigned keys in the order the fields were
listed (familyName, fullName, dateOfBirth, email… for Vorname, Feld2, Geb, Feld4…), gave keys to
names that say nothing ("Feld9" → iban), or echoed the field name as the key. Asking it to answer
"unknown" unless a field names the detail, and not to go by position, did not fix it. Form
filling therefore does not use the on-device model; the synonym list and a custom provider do.

### Semantic diff with Apple's model

On 2026-09-15, through the iOS simulator (`DiffMeasurementTests`), on `conformance/diff/`, three
runs: both reworded pairs labelled correctly every time — "shall pay the rent monthly" → "rent is
payable every month" as `wordingOnly`, 30 → 60 days as `meaningChanged` with the summary "The
notice period is now 60 days instead of 30 days." About 5 s per run for the two calls. Two pairs
are a small sample; a longer document with subtler rewording is unmeasured.

### Chrome's built-in Summarizer

On 2026-09-15, Chrome 152 on an Apple M3 Max, headless, in its own profile
(`node web-ai/scripts/measure-chrome-summarizer.mjs`). The model downloaded in about 2.5 minutes
after one `create()` with a user gesture. Available for English, German and Japanese.

- `conformance/fixtures/contract.pdf`: a paragraph in 4.3 s and five key points in 2.6 s, both
  grounded in the text (parties, Annex A, two-year term from 1 March 2026, renewal, three-month
  notice in writing).
- The German page of `conformance/redaction/pii.pdf`, asked for as German: a German summary in 4.0 s.
- **Input quota 9216 tokens, and the SDK's limit was wrong.** Measured with `measureInputUsage`,
  text full of numbers and emails costs 1.71 characters per token plus about 440 tokens of fixed
  overhead; the SDK assumed 3 characters per token, and a 30-page dense document failed its
  first call with `QuotaExceededError`. The limit is now measured on the document's own text, each
  call is checked, and an over-quota input is summarised in halves: the same document now summarises
  in 3 calls and 19 s.

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

**ML Kit's input limit is 7,860 characters**, which it states when refusing longer
input (`REQUEST_TOO_LARGE`). The SDK had assumed 9,000 from the documented token count; it
now uses 7,860. On the phone, 7,860 characters summarise and 7,861 are refused, and a
40,000-character, 20-page text went through the SDK's splitting and combining in 14 s:
eight calls, every one between 400 and 7,860 characters. That run predates windows. With
windows, on the same phone, the 36,000-character, 30-page text of ten topics took five
calls of 7,077 to 7,502 characters in 9.5 s, and the three bullets named nine of the ten
topics (force majeure was left out).

Windows against Apple's real model: a 36,000-character, 30-page text of ten repeating
topics went through three windows of 14,286, 14,031 and 9,137 characters (limit 14,745) in
22 s, and the summary named all ten topics, early pages and late. Its bullets came back as
"- - ": the model re-bullets the summary it was given.

Code 30 now surfaces as a new reason on every platform, `backgroundUseBlocked`, through a
`PdfAiUnavailableError` a route can throw to name why it failed; a later route that answers
still wins. On the phone, the SDK called from the test process returns
`BACKGROUND_USE_BLOCKED`.

Two things the phone did show, both fixed on every platform they apply to:

- **ML Kit refuses article input under 400 characters.** Text that short is no longer
  sent: the on-device route steps aside for the next one, and a short part of a longer
  document — a window that would be that short — is not sent, and its text is kept after the
  summary as it is.
- **A route that throws was reported as `noProvider`**, telling the integrator to
  configure something that was not missing. When a route throws and nothing else
  answers, the reason is now `requestFailed`.

### ML Kit image description on a real phone

On 2026-09-16, the same Samsung SM-F971B, on `conformance/alt-text/tagged.pdf` through the demo
(`adb shell am start -n com.pdfiumkit.demo/.MainActivity -e measure alt-text`, results in
`adb logcat -s MEASURE`). The feature was `DOWNLOADABLE`; `altText.prepare()` made it available in
under a second. `altText.suggest()` then took 4.6 s for the document's three figures: the thin rule
was called decorative by the rules, and both images were described on device
(`source=ON_DEVICE`) — "This is a simple, minimalist graphic featuring a large yellow circle
against a dark blue background, with a dark gray rectangle in the lower left corner." and "This is
a solid, circular red shape made up of small, square pixels." Both are accurate; neither uses the
page text, which the API cannot take.

**A resumed activity is not enough: the screen must be on.** The first run, with the phone dozing,
failed every inference with code 30 (`BACKGROUND_USE_BLOCKED`) even though the activity was
resumed; waking and unlocking the device made the same code run. The SDK reports this as
`backgroundUseBlocked` and the next route takes over, so hosts should treat on-device image
description as unavailable while the screen is off.

`availability()` and `prepare()` for image description were added for this measurement: the demo
cannot reach ML Kit itself, and AVL-4 forbids the SDK downloading a model on its own.

## Not verified

- **A custom provider has never been used for real** — the tests use fakes, and no hosted
  vision or text model has been called.
- **One document.** The contract is short and clean; a real model on long or messy text,
  or in another language, is unmeasured.
- **Characters per token** is fixed at 3 everywhere, conservative for English and
  unmeasured for German or Japanese.
- **SUM-4 streaming** and **cancellable indexing** (ANS-7's second half) are not built.
- **Language detection** is not built: SUM-3 applies only when the host passes a language.

## Decisions taken without a person

- Android answers use the custom provider only; `experimentalOnDevicePrompt` does nothing
  yet (open question 6).
- No ready-made provider adapters ship (open question 4).
- `PdfWorker` gained nothing for AI: `pdfiumkit-ai` works with the in-process document.
