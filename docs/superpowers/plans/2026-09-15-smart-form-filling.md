# Smart Form Filling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Propose values for a PDF form's fields from a host-supplied profile, matched by a multilingual synonym list (and a model for what it cannot match), reviewed as labelled marks, applied with undo.

**Architecture:** `pdfcora-ai` describes each field (name, tooltip, nearby label, kind, options), matches it to a profile key (synonyms first, model second), formats the value for the field, and returns proposals whose `apply` writes through the core form setters after a snapshot. The core viewer marks gain an optional `label`. Behaviour is pinned across platforms by `conformance/forms/matching.json` and `forms-expected.json`; the web implementation is the reference the Swift and Kotlin ports follow function for function.

**Tech Stack:** TypeScript, Swift 5.9 / SwiftUI, Kotlin 1.9 / Compose, PDFium.

**Spec:** `docs/superpowers/specs/2026-09-15-smart-form-filling-design.md`

## Global Constraints

- Profile keys, in tie-break order: `givenName`, `familyName`, `fullName`, `dateOfBirth`, `email`, `phone`, `street`, `postalCode`, `city`, `country`, `iban`, `company`.
- Synonyms, normalisation and the matching rule: exactly spec §5.1.
- Label rule: exactly spec §4 (±2 pt, 250 pt, 14 pt).
- Fillable kinds: text, checkBox, radioButton, comboBox, listBox; read-only fields are skipped.
- Proposal id: `"<pageIndex>:<annotationIndex>:<key>"`. Notice: `Check every value before filling in the form.` (through the AI trial prefix).
- `value`: string for text, option index for choices, `true` for toggles.
- Test profile (used by every fixture): givenName `Anna`, familyName `Schmidt`, fullName `Anna Schmidt`, dateOfBirth `1985-03-14`, email `anna.schmidt@example.com`, phone `+44 20 7946 0958`, street `221B Baker Street`, postalCode `NW1 6XE`, city `London`, country `United Kingdom`, iban `GB29 NWBK 6016 1331 9268 19`, company `Example Holdings Ltd`.
- Commands run from `/Users/daos/Projects/Lab/PdfiumKit-v2`; iOS selected tests via `./build/run-ios-tests.sh`, Android devices via `ANDROID_SERIAL=emulator-5554`.

---

### Task 1: Shared fixtures

**Files:** Create `conformance/forms/matching.json`, `conformance/forms/make-forms.mjs`, `conformance/forms/forms.pdf`, `conformance/forms/forms-expected.json`.

- [ ] Write `matching.json`: `[{ "name", "alternateName", "label", "kind", "expected" }]` cases covering every key in English and German, the longest-phrase rule ("Nachname" vs "name", "Street address"), the order rule (tooltip before label before name), format hints stripped, and unknowns.
- [ ] Write `make-forms.mjs`: a hand-written PDF (like `make-pii.mjs`) with an AcroForm; page 0 English, page 1 German; each field a widget with `/T`, optional `/TU`, `/Rect`, `/FT` (`/Tx`, `/Ch` with `/Opt` and combo flag, `/Btn` checkbox with `/AP /N /Yes /Off`, `/Btn` push button flag, `/Sig`), and its label printed as page text to its left (or above). Include a ZIP/City pair on one line, a combo whose options do not include the profile country (German page), a checkbox with no profile meaning, a signature and a push button, and a field with no matching label.
- [ ] Write `forms-expected.json`: `[{ "pageIndex", "fieldName", "key", "value" }]` in page then annotation order, for the test profile.
- [ ] Run the generator and read the fields back with the web SDK: every field present with the expected kind and rect.
- [ ] Commit.

### Task 2: Web — synonyms and field descriptions

**Files:** Create `web-ai/src/forms/synonyms.ts` (`PROFILE_KEYS`, `normalise`, `matchKey(text): PdfProfileKey | null`, `matchField(desc): PdfProfileKey | null`), `web-ai/src/forms/describe.ts` (`describeFields(document, pages?): Promise<PdfFieldDescription[]>` with labels), tests `web-ai/test/forms-matching.test.ts`.

- [ ] Test: every `matching.json` case; `describeFields` on `forms.pdf` gives the expected label for each field.
- [ ] Implement per spec §4, §5.1. Run; commit.

### Task 3: Web — proposals, formatting, model, apply and undo

**Files:** Create `web-ai/src/forms/propose.ts`; modify `web-ai/src/index.ts` (`forms.propose`); test `web-ai/test/forms-propose.test.ts`.

- [ ] Tests: no model → exactly `forms-expected.json`; fake provider fills an unknown field, cannot override a synonym, bad key dropped; `apply` writes accepted values only (read back with `formFields`), unknown id writes nothing, `undo` restores; date formats per hint; combo without the value gets nothing.
- [ ] Implement per spec §5.2, §5.3, §6, §7. Run web-ai suite; commit.

### Task 4: Core marks label (web, iOS, Android)

**Files:** web `view/state.ts` + `ui/viewerElement.ts`; iOS `View/Marks.swift` + `PDFCoraUI/PdfViewerView.swift`; Android `view/Marks.kt` + `pdfcora-ui/PdfViewerView.kt`.

- [ ] `PdfMark` gains optional `label`; components draw it inside the mark (small text, clipped). Browser test asserts the label text is in the DOM; existing UI tests still pass. Commit.

### Task 5: iOS — port of Tasks 2 and 3

**Files:** `ios/Sources/PDFCoraAI/Forms/{Synonyms,Describe,Propose}.swift`; tests `ios/Tests/PDFCoraAITests/{FormMatchingTests,FormProposeTests}.swift`.

- [ ] Same tests against the same fixtures; model route adds Apple on-device before the provider. Run AI suite; commit.

### Task 6: Android — port of Tasks 2 and 3

**Files:** `android/pdfcora-ai/src/main/java/com/pdfcora/ai/forms/{Synonyms,Describe,Propose}.kt`; JVM test for matching, instrumented test for proposals (fixtures as androidTest assets).

- [ ] Same tests; provider route only. Run; commit.

### Task 7: Demo, measurement, docs, gates

- [ ] iOS demo "Form Filling" screen proposing from the test profile into the component review; UI test accepts all and applies.
- [ ] Opt-in Apple measurement on the fields the synonyms leave unknown plus a copy of the form with the tooltips/labels removed (names only), recorded in the AI plan document.
- [ ] README row and section, HANDOFF, requirements §9 status, spec status.
- [ ] Every gate; push; CI.
