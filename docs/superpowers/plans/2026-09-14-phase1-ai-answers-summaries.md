# pdfiumkit-ai Phase 1 — Answers and Summaries

**Goal:** grounded answers that highlight the exact sentence they came from, and
summaries of a document or page range, on iOS, Android and Web.

**Spec:** `docs/superpowers/specs/2026-09-13-pdfiumkit-ai-requirements.md` §§8, 10, 15

**Status:** built on all three platforms, tested against fakes of every model. **No real
model has been run** — see "Not verified".

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
the passage it names, tolerating whitespace and line-end hyphenation only; a citation
that cannot be found is dropped and the answer marked `grounded = false` (ANS-3). Ranges
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
platforms, alongside a made-up quote, a real sentence attributed to the wrong passage,
and a question with no answer.

The Phase 0 stub is gone, as its own comment asked; the demos show answers and summaries.

## Not verified

- **No real model has answered anything.** Apple's model, ML Kit and Chrome's summariser
  are exercised only through fakes. A simulator reports Apple's model inconsistently, the
  emulator has no AICore, and Node has no `Summarizer`. The quote check exists precisely
  because a real model will paraphrase; how often it does is unmeasured.
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
