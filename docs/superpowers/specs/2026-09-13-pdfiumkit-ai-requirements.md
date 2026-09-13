# pdfiumkit-ai — Product Requirements

Date: 2026-09-13
Status: Draft 0.3, pending review
Extends: `2026-09-12-pdfiumkit-sdk-design.md`, `2026-09-13-signatures-and-redaction-design.md`
Source: requirements draft 0.1, published as an artifact and filed here unchanged except
for the corrections in §0.

An optional package that adds on-device AI to PdfiumKit on iOS/macOS, Android and Web.
What sets it apart: answers that highlight the exact sentence on the page they came
from. A generic chatbot cannot do that.

The core SDK stays as it is — same size, same dependencies.

Requirement IDs are stable once reviewed. Add new ones rather than renumbering.

## 0. Corrections to draft 0.1

Draft 0.1 left seven open questions. Four are answerable from the codebase as it stands
today, and two of those were blocking the phase order. What changed:

**Open question 1 — "Can the core remove content when redacting?" → Yes.** Redaction
shipped on 2026-09-13 (`ac18691`, `797c3f6`). The objects a region touches are removed
and the content stream regenerated; the contract is asserted identically on all three
platforms by a raw-byte scan of the saved file, not by text extraction. RED-5 is
therefore unconditional, and Phase 2 no longer depends on an unknown.

**Open question 2 — "Can the core write the structure tree?" → Not through PDFium, but
the route exists.** Every `FPDF_StructTree*` and `FPDF_StructElement*` export in this
build is a `Get*`; there is no Set, Create or Add, and PDFium cannot create a PDF
dictionary at all. However `PdfWriter` already hand-builds incremental updates — that is
how signing writes its signature dictionary — so writing `/Alt` is **core work, not a
wall**. Reading tags is possible with the existing exports but is not yet wrapped in the
SDK, so ALT-1 needs a read API as well as a write path. Phases 2 and 3 keep their order.

**PKG-3 — the OS floors hold.** `Package.swift` declares `.iOS(.v15)` and
`android/pdfiumkit/build.gradle.kts` declares `minSdk = 23`. The ML Kit GenAI floor is
still unverified.

**ANS has a larger head start than draft 0.1 assumed.** `FPDFText_GetCharBox` is already
in use on all three platforms by the redaction splitter, and "quote → character range →
highlight rectangles" is the same machinery redaction uses to resolve a region to
objects. `FPDFImageObj_GetImageDataDecoded` and `FPDFImageObj_GetRenderedBitmap` are
exported, and `pageObjects` already reports `.image` with bounds, so ALT-1's input is
close to hand.

**FORM-6 was unachievable as written.** Draft 0.1 said the core "reads and writes 8 field
kinds". It reads 8 and writes 5; `pushButton`, `signature` and `unknown` carry no
fillable value. FORM-6 now targets the 5 that can be filled.

**Apple's on-device model does not accept images.** Draft 0.1 opened §11 with "Apple's
on-device model now accepts images" and marked alt text on iOS/macOS as on-device pending
an OS check. Checked against the shipping interface
(`FoundationModels.framework/.../arm64e-apple-ios.swiftinterface`, iOS 26.4 SDK, Xcode
26.4): the word *image* does not occur anywhere in it, and the only conformances to
`PromptRepresentable` are `String`, `Prompt`, `Array` and `ConvertibleToGeneratedContent`.
The model is text-only. **Alt text on Apple platforms falls back to the custom provider,
exactly as on Web**, until Apple ships image input. This answers open question 5.

**ANS-1's context window is confirmed, and readable at runtime.**
`SystemLanguageModel.contextSize` is a public property that returns `4096`, back-deployed
before iOS 26.4. Read it rather than hardcoding the number, so the budget follows the OS.
The VERIFY on ANS-1 is resolved.

Open questions 3, 4, 6 and 7 remain open and are unchanged.

## 1. Scope and assumptions

### Goals

- Ship the AI features that on-device models can handle well, starting with grounded
  answers.
- Keep the core SDK's size and dependencies exactly as they are.
- Behave predictably on every device. Each feature either runs, falls back, or clearly
  reports that it is not available.
- Keep a person in charge of every change made to a document.

### Non-goals for v1

- Hosting or reselling a cloud model. Cloud inference happens only through a custom
  provider that the integrator supplies.
- Applying redactions, form values, tags or alt text automatically.
- OCR for scanned pages that have no text layer.
- Committing to an agent product. MCP is tracked as a side bet.

### How the two source lists were combined

The *"where AI fits"* list ranks features by how well they suit small on-device models.
The *strategic* list ranks by market strength. The phasing below uses both, plus the
technical dependencies between features.

- The accessible viewer (strategic #1) is not an AI feature. It is specified here as a
  **core** track because alt text and remediation build on it.
- "AI form-field detection" is split in two: matching the meaning of existing form
  fields (v1), and detecting fields on flat PDFs that have none (later).
- Platform API names reflect vendor documentation at the time of drafting. Items marked
  **VERIFY** must be re-checked before implementation.

## 2. Features at a glance

The v1 plan for how each feature runs on each platform. When no on-device model is
available, every cell falls back to the integrator's custom provider if one is
configured.

| Feature | iOS / macOS | Android | Web |
|---|---|---|---|
| Grounded answers | On-device | Custom provider · experimental on-device | Custom provider |
| Smart form filling | On-device · synonym list | Synonym list · experimental on-device | Synonym list · custom provider |
| Summaries | On-device | On-device (beta) | Chrome desktop · custom provider |
| Alt text | Custom provider *(model is text-only)* | On-device (beta) **VERIFY** | Custom provider |
| Redaction suggestions | Patterns · on-device | Patterns · experimental on-device | Patterns · custom provider |
| Semantic diff | Later | Later | Later |

## 3. Packaging — PKG

| ID | Level | Requirement |
|---|---|---|
| PKG-1 | MUST | AI ships as a separate, optional package on every platform, released alongside the core with matching version numbers. Proposed names: Swift package product `PdfiumKitAI`, Android artifact `pdfiumkit-ai`, npm package `pdfiumkit-ai`. |
| PKG-2 | MUST | The core's resolved dependency graph contains no ML Kit, Google Play services, AICore or FoundationModels references. A CI check fails the core build if one appears. |
| PKG-3 | MUST | Adding `pdfiumkit-ai` does not raise an app's minimum OS. On Apple platforms it keeps iOS 15 support, weak-links FoundationModels and checks `if #available` before every use. On Android, any higher `minSdk` required by ML Kit GenAI is handled and documented. **VERIFY the ML Kit floor.** |
| PKG-4 | SHOULD | `pdfiumkit-ai` uses only the core's public API (text with character positions, form fields, annotations, images), with no private hooks. Integrators who build their own AI get the same capabilities. |

Confirmed today: the core is `.iOS(.v15)` and `minSdk = 23`, so PKG-3's floors are the
ones the core already ships.

## 4. Availability — AVL

Whether a feature is available depends on the end user's device, not on us. An iPhone
without Apple Intelligence, a mid-range Android phone, or Safari has no on-device model.
Every feature needs a clean path for that case.

| ID | Level | Requirement |
|---|---|---|
| AVL-1 | MUST | Report one availability model on all platforms: `available`, `downloadable`, `downloading`, `unavailable(reason)`. |
| AVL-2 | MUST | Report availability per feature, not per package. On Android, summarization can be available while prompt-based features are not. |
| AVL-3 | MUST | Re-check availability each time a feature is used. It can change during a session: the user turns off Apple Intelligence, or the system removes a model. |
| AVL-4 | MUST NOT | Start a model download on its own. The host app calls `prepare()`, and the SDK reports download progress. |
| AVL-5 | MUST | Every feature call returns a typed "not available" result instead of throwing a generic error. The sample app on each platform shows the not-available screen for every feature. |

### Mapping platform checks to one model

Checked with `SystemLanguageModel.default.availability` · `checkFeatureStatus()` ·
`Summarizer.availability()`.

| State | iOS / macOS | Android | Web |
|---|---|---|---|
| available | `.available` | `AVAILABLE` | `"available"` |
| downloadable | managed by the system | `DOWNLOADABLE` | `"downloadable"` |
| downloading | `.unavailable(.modelNotReady)` | `DOWNLOADING` | `"downloading"` |
| unavailable · device | `.unavailable(.deviceNotEligible)` | `UNAVAILABLE` | `"unavailable"` |
| unavailable · turned off | `.unavailable(.appleIntelligenceNotEnabled)` | — | — |
| unavailable · platform | OS too old (`#available` fails) | AICore missing | API not defined: Safari, Firefox, mobile Chrome |
| unavailable · no provider | No on-device model for this feature, and no custom provider configured | | |

```swift
// Illustrative. Android and Web use the same structure.
let ai = PdfiumAI(document: doc, customProvider: nil)

switch await ai.answers.availability() {
case .available:
    let result = try await ai.answers.ask("What's the notice period?")
    if let cite = result.citations.first {
        viewer.highlight(page: cite.pageIndex, range: cite.charRange)
    }
case .downloadable, .downloading:
    showPreparing()
case .unavailable(let reason):
    showNotAvailable(reason)
}
```

## 5. Providers and privacy — PRV

| ID | Level | Requirement |
|---|---|---|
| PRV-1 | MUST | Offer a custom provider interface for integrators to implement (their own server or model). It takes a prompt, optional images and an optional output schema, and returns text or structured output. |
| PRV-2 | MUST | Try sources in a fixed order: on-device platform model, then the custom provider if configured, then the feature's non-AI fallback (patterns, synonym list), then `unavailable`. |
| PRV-3 | MUST | Every result states where it came from: `onDevice`, `customProvider` or `rules`. Hosts can show this to users and log it for audits. |
| PRV-4 | MUST | Document content never leaves the device, except through a custom provider the integrator configured. The SDK does not log document text or send it in telemetry. |
| PRV-5 | SHOULD | On Android and Web, features built on the alpha prompt APIs are off unless the integrator opts in, e.g. `experimentalOnDevicePrompt = true`. Summarization does not need the opt-in. |

**Why the general prompt API is custom-provider-first outside Apple platforms.** ML
Kit's Prompt API is still alpha on Android. In Chrome, the Prompt API is stable only for
extensions, not ordinary web pages. Summarization is the most solid AI feature on every
platform today.

**Android runtime limits:** handle AICore quota or busy errors and any restrictions on
running inference in the background. **VERIFY.**

The provider interface follows the precedent already set by signing: the web SDK takes a
`CmsSigner` from the app rather than bundling a CMS implementation, for the same reason
— bundling would burden every consumer including those that only read.

## 6. Human confirmation — HIL

| ID | Level | Requirement |
|---|---|---|
| HIL-1 | MUST | Any feature that would change a document (form values, alt text, tags, redactions) returns *proposals*. Nothing is written until the host calls `apply()` with the proposals the user accepted. |
| HIL-2 | MUST | Changes made with `apply()` can be undone until the document is saved. |
| HIL-3 | SHOULD | Ship a default review UI on each platform: a list of proposals the user can accept, edit or reject individually or all at once. The headless API is always available too. |

## 7. Customer documentation — DOC

| ID | Level | Requirement |
|---|---|---|
| DOC-1 | MUST | Link Apple's acceptable-use requirements for the Foundation Models framework, and state that apps using `pdfiumkit-ai` on Apple platforms must follow them. |
| DOC-2 | SHOULD | Do the same for Google's generative AI usage policies covering ML Kit GenAI and Chrome's built-in AI. **VERIFY which terms apply.** |
| DOC-3 | MUST | For each feature, document device and OS requirements, supported languages, known limits, and what users see when it is not available. |

## 8. Grounded answers — ANS

The user asks a question. The SDK finds the relevant text, the model answers, and
PdfiumKit highlights the exact sentence using the character positions it already has.
Because retrieval keeps the prompt short, this also works well with small models.

Worked example — asking "What's the notice period?" of a contract whose §12.1 reads
"*The notice period is three months, ending on the last day of a calendar month*" returns
that sentence as the answer and highlights exactly it, citing page 4, chars
18,402–18,481, source `onDevice`. The highlight comes from the verified quote's
character range, never from coordinates the model returned.

| ID | Level | Requirement |
|---|---|---|
| ANS-1 | MUST | Index each page's text layer with character positions. Retrieval runs on the device without a model (keyword ranking such as BM25) and picks passages that fit the model's prompt budget. Take the budget from the platform — on Apple, `SystemLanguageModel.contextSize`, which returns 4096 today — rather than hardcoding a number. |
| ANS-2 | MUST | Ask the model to answer only from the supplied passages and to return structured output: the answer, a passage ID, and the supporting sentence quoted word for word. Use guided generation on Apple and a response schema elsewhere. |
| ANS-3 | MUST | Check each quote against the source text, tolerating differences in whitespace and hyphenation. Map it to a character range, then to highlight rectangles. Citations that cannot be verified are dropped, and the result is marked `grounded = false`. |
| ANS-4 | MUST | If retrieval finds no relevant passage, return `notFound` without calling the model. |
| ANS-5 | MUST | A citation includes page index, character range, rectangles and quoted text. Tapping it scrolls to the sentence and highlights it. |
| ANS-6 | MUST | Report pages that have no text layer, e.g. "12 of 40 pages have no text and weren't searched". |
| ANS-7 | SHOULD | Support up to three citations for answers drawn from several places. Build the index off the main thread, and let it be cancelled. |

**What exists already.** ANS-1's character positions and ANS-3/ANS-5's range → rectangle
mapping are the machinery the redaction splitter already uses on all three platforms
(`FPDFText_GetCharBox`, `PdfTextPage`, `redact/split.ts`). The new work is retrieval,
the prompt contract and quote verification — not the text plumbing.

### Acceptance

- Given a test contract where §12.1 states the notice period, asking "What's the notice
  period?" highlights exactly that sentence and nothing else.
- A question with no answer in the document returns `notFound`.
- A made-up quote injected into the model output in a test never produces a highlight.

## 9. Smart form filling — FORM

The model recognises that "Nachname", "Surname_1" and "Last name" are the same field, and
proposes values from the user's profile. The user confirms before anything is filled in.

The core reads 8 field kinds and writes 5 of them: `text` via `setText`, `checkBox` and
`radioButton` via `setChecked`, `comboBox` and `listBox` via `setOption`. The remaining
three — `pushButton`, `signature`, `unknown` — carry no fillable value. Draft 0.1 said
"reads and writes 8", which would have set FORM-6 an impossible target.

| ID | Level | Requirement |
|---|---|---|
| FORM-1 | MUST | Describe each field using its name, tooltip (alternate name), options or export values, field kind, nearby label text on the page, and position. |
| FORM-2 | MUST | Match each field to a fixed profile schema: given name, family name, date of birth, email, phone, street, postal code, city, country, IBAN and so on. The model may return only schema keys or `unknown`. |
| FORM-3 | MUST | Include a multilingual synonym list that works without a model (e.g. "Nachname", "Surname", "Last name", "Nom" all mean family name). It runs on devices without a model and double-checks the model's matches. |
| FORM-4 | MUST | The host passes in the profile values for each call. The SDK does not store them. |
| FORM-5 | MUST | Format proposed values to suit the field: a checkbox's export value, a matching choice option, the field's date format. If a value does not fit the field, do not propose it. |
| FORM-6 | MUST | Cover the 5 fillable field kinds, and classify the other 3 as not fillable rather than proposing values for them. Fields are written only through `apply()` (HIL-1). |
| FORM-7 | MAY | Later: detect fields on flat PDFs that have no form fields, and propose creating them. This needs layout or image understanding and is not in v1. |

### Acceptance

- On a test set of English and German forms, field-matching precision meets a target set
  after the first baseline measurement.
- No field value changes until `apply()` is called.
- A choice field whose options do not include the profile value gets no proposal.

## 10. Summaries — SUM

Summaries do not set PdfiumKit apart, but users expect them. They are also the most
mature on-device API on every platform, and on Android and Chrome the platform
summarizer can be called directly.

| ID | Level | Requirement |
|---|---|---|
| SUM-1 | MUST | Summarize the whole document or a page range, as a short paragraph or as key points. |
| SUM-2 | MUST | For long documents, split the text by section or page to stay within each platform's input limit, summarize each part, then combine the results. |
| SUM-3 | MUST | If the platform does not support the document's language, return `unavailable(languageNotSupported)` rather than a poor summary. |
| SUM-4 | SHOULD | Stream partial output where the platform supports it. |

Platform routes: FoundationModels session with a summary prompt on iOS/macOS; ML Kit
GenAI Summarization via AICore (Gemini Nano) on Android; the Chrome Summarizer API on
desktop Chrome only.

### Acceptance

- On a supported device on each platform, a 50-page sample summarizes without exceeding
  input limits.
- On an unsupported device or browser, the call returns `unavailable` with a reason, and
  the sample app shows the fallback screen.

## 11. Alt text and accessibility remediation — ALT · REM

Alt text feeds the accessibility roadmap, with a person confirming every description.
Remediation takes the same approach to tags and reading order.

**No Apple on-device route exists.** `FoundationModels` is text-only as of iOS 26.4 (§0),
so alt text on Apple platforms needs the custom provider, like Web. Only Android has an
on-device image-description model, and it is in beta. This makes alt text the one feature
whose flagship platform is *not* Apple — worth knowing before Phase 3 is scheduled.

| ID | Level | Requirement |
|---|---|---|
| ALT-1 | MUST | List the images (and figures in tagged PDFs) that have no alt text, and propose a description for each, using the surrounding text as context. |
| ALT-2 | MUST | A person confirms or edits each description before it is written. |
| ALT-3 | MUST | For images that look decorative, propose marking them as decorative instead of describing them. |
| ALT-4 | MUST | Write confirmed descriptions to the structure tree (`/Alt` on the Figure element). Requires a core write path — see below. |
| REM-1 | SHOULD | For untagged PDFs, propose tags (headings, lists, tables, figures) and a reading order, shown as an overlay on the page for review. |
| REM-2 | MUST | Nothing is committed without confirmation. Remediated test documents pass PDF/UA-1 validation (veraPDF) in CI. |

**The core work ALT-4 and REM depend on.** PDFium's structure-tree API is read-only —
every `FPDF_StructTree*` and `FPDF_StructElement*` export is a `Get*`, and PDFium cannot
create a dictionary. Writing `/Alt` therefore goes through `PdfWriter`, the same
hand-built incremental-update path that writes signature dictionaries. Two pieces of core
work fall out of this, and neither is speculative:

1. A **read** API wrapping the existing `FPDF_StructElement_*` exports, which ALT-1 needs
   to find figures that lack alt text. None of them is wrapped in the SDK today.
2. A **write** path in `PdfWriter` for structure-tree entries.

Platform routes: custom provider on iOS/macOS and Web; ML Kit GenAI Image Description on
Android (**VERIFY LANGUAGES**).

## 12. Redaction suggestions — RED

Flag likely personal data by combining a model with plain pattern matching. The SDK only
ever suggests. A small model will miss things, and a missed redaction leaks data.

| ID | Level | Requirement |
|---|---|---|
| RED-1 | MUST | Find IBANs (validated with the ISO 13616 mod-97 checksum), email addresses and phone numbers with pattern matching alone. This works on every device. |
| RED-2 | SHOULD | Use the model to flag personal data that depends on context: names, postal addresses, dates of birth. |
| RED-3 | MUST | Each suggestion includes its category, its source (pattern or model), character range and rectangles. Suggestions appear as marks to review and are never applied automatically. |
| RED-4 | MUST | The review UI and the docs say plainly that suggestions may be incomplete, and that a person must still review the whole document. |
| RED-5 | MUST | Applying a confirmed redaction removes the underlying text and image content from the saved file, not just covers it with a box. |

**RED-5 is satisfied by the core as of 2026-09-13.** `PdfDocument.redact` removes the
objects a region touches and regenerates the content stream; partially covered text runs
are rewritten with the covered characters dropped. The document must be saved with the
full save mode — an incremental save writes no regenerated content stream, so the removed
content would stay in the file. The conformance contract asserts the removed string is
absent from the saved **bytes**, on all three platforms. `pdfiumkit-ai` supplies the
suggestions; the core supplies the removal.

### Acceptance

- Pattern matching finds every valid IBAN and email address in the synthetic test set,
  and ignores IBANs that fail the checksum.
- How much personal data the model catches is measured per language and published in the
  docs.
- No redaction is applied without confirmation.

## 13. Accessible viewer — A11Y (core track)

The strongest item on the strategic list, and a core feature rather than an AI one. It
covers the viewer UI and how tagged content is exposed to assistive technology. An
untagged PDF cannot conform by itself, which is where remediation comes in.

| ID | Level | Requirement |
|---|---|---|
| A11Y-1 | MUST | The viewer conforms to EN 301 549 (v3.2.1), which includes WCAG 2.1 Level AA, on every platform. |
| A11Y-2 | MUST | Expose tagged PDF content to VoiceOver, TalkBack and browser screen readers in reading order, including headings, lists, tables, alt text and form field labels. |
| A11Y-3 | MUST | Every viewer control works from the keyboard on Web and macOS, with a visible focus indicator. The UI supports zoom and text scaling. |
| A11Y-4 | MUST | Publish an Accessibility Conformance Report for each platform (VPAT® EU or INT edition), based on an independent audit. |

A11Y-2 needs the same structure-tree read API as ALT-1. Building it once serves both.

## 14. Later and side bets

**Semantic document diff — later.** Match up sections across two versions by their text.
The model then labels each changed pair (*meaning changed* or *wording only*) and
summarizes the changes in meaning, with both versions highlighted using character
positions. It relies on the general prompt API, so Android and Web would start with a
custom provider.

**MCP / WebMCP tools for agents — side bet.** Give agents read-only tools (search, get
text, list fields) and proposal-based write tools that follow HIL-1. No v1 commitment:
Syncfusion already ships MCP, and WebMCP is still a Chrome Canary preview. Revisit when
WebMCP reaches an origin trial.

## 15. Phasing

**Phase 0 — Foundation.** Packages (PKG), availability model (AVL), custom provider
interface (PRV), review API (HIL), customer docs (DOC). The accessible viewer (A11Y) runs
in parallel as a core track.
*Exit:* the sample app on each platform shows the not-available screen for a stub
feature, and the CI dependency check on the core passes.

**Phase 1 — Answers and summaries.** Grounded answers: on-device on Apple, custom
provider on Android and Web. Summaries: on-device on all three platforms.
Answers lead because they set PdfiumKit apart. Summaries ship with them because they are
the most reliable API everywhere.

**Phase 2 — Forms and redaction.** Smart form filling with the synonym list on every
device. Redaction patterns on every device, plus model suggestions.
*No longer blocked:* the core removes content as of 2026-09-13, so RED-5's apply step
ships with this phase.

**Phase 3 — Alt text and remediation.** Alt-text proposals, and tag and reading-order
proposals.
The strategic list ranks remediation second. It is phased third because it needs two
pieces of core work first — a structure-tree read API and a `PdfWriter` write path (§11).
Both are known quantities rather than open questions, so this phase can be scheduled; it
cannot be shortened by swapping it with Phase 2.

**Later — side bets.** Semantic diff, field detection on flat PDFs (FORM-7), MCP /
WebMCP tools. The experimental Android prompt features move to on-device by default once
ML Kit's Prompt API reaches beta.

## 16. Open questions

1. ~~Can the core remove content when redacting?~~ **Answered in §0: yes, as of
   2026-09-13.**
2. ~~Can the core write the structure tree?~~ **Answered in §0: not through PDFium, but
   `PdfWriter` is the route. Scoped as core work in §11.**
3. Which languages do the synonym list and the quality targets cover at launch? The
   "Nachname" example suggests at least English and German.
4. Should we ship ready-made custom provider adapters (e.g. for a server-side model), or
   only the interface?
5. ~~Which minimum iOS and macOS versions support image input in Apple's on-device
   model?~~ **Answered in §0: none. The model is text-only as of iOS 26.4.** Re-open if a
   later OS adds it.
6. On Android, should prompt-based features ship now behind the experimental opt-in, or
   wait for ML Kit's Prompt API to reach beta?
7. Is the accessible viewer track owned by this program or by the core team?
