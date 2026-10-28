# PDFCora — Redaction Suggestions Design

Date: 2026-09-15
Status: Implemented 2026-09-15
Implements: RED-1 to RED-5 and HIL-1 to HIL-3 of `2026-09-13-pdfcora-ai-requirements.md`
(AI Phase 2, first half; smart form filling follows in its own spec)

## 1. Purpose

Find likely personal data in a document, show it to a person as marks on the page, and
redact what they accept. The SDK only suggests: a person reviews every suggestion and the
whole document, because a missed suggestion leaks data.

Success criteria:

- The patterns find exactly the expected items in a shared test document, identically on
  iOS, Android and web, and ignore IBANs and card numbers whose checksum fails.
- A model suggestion is only ever text that is in the document.
- Nothing changes in the document until `apply`; accepted text is absent from the saved
  bytes afterwards, rejected text is still there, and `undo` restores the document.
- The review UI always shows that suggestions may be incomplete.

## 2. Decisions

| Question | Decision |
| --- | --- |
| First Phase 2 feature | Redaction suggestions; form filling next |
| Where it lives | Detection in `pdfcora-ai`; generic marks in the core viewer and UI components |
| Pattern categories | IBAN, email, phone, payment card, date, URL, IP address |
| Regions | International phone numbers; English and German national phone and date formats |
| Model categories | Person names, postal addresses, dates of birth, ID numbers |
| Review | Marks in the existing viewer components, with a review bar |
| Undo | Snapshot before apply; undo opens the snapshot |
| Model measurement | Apple's on-device model through the iOS simulator; no server model for now |

## 3. Finding suggestions

### 3.1 API

Web shown; iOS and Android follow each platform's conventions with the same shape.

```ts
const ai = new PdfAI(document, { provider });   // provider optional
const review = await ai.redactions.suggest({ pages?, categories? });

review.suggestions;  // PdfRedactionSuggestion[]
review.modelUsed;    // false when no model was available, so only patterns ran
review.notice;       // "Suggestions may be incomplete. Review the whole document."
```

```ts
interface PdfRedactionSuggestion {
  readonly id: string;
  readonly category: PdfRedactionCategory;
  readonly source: 'rules' | 'onDevice' | 'customProvider';
  readonly pageIndex: number;
  readonly start: number;   // character range in the page text
  readonly end: number;
  readonly text: string;
  readonly rects: readonly PdfRect[];
}

type PdfRedactionCategory =
  | 'iban' | 'email' | 'phone' | 'paymentCard' | 'date' | 'url' | 'ipAddress'   // patterns
  | 'personName' | 'postalAddress' | 'dateOfBirth' | 'idNumber';                // model
```

`categories` restricts what is looked for; the default is all. Suggestions are ordered by
page, then by `start`. Ids are stable for the same document and options, so a host can
keep review state across a re-render.

Applying suggestions goes through the core `redact()`, as it already does.

### 3.2 Text

The page text comes from the existing text layer (`readPages`), and rectangles from the
existing `rectsForRange`, which merges character boxes into one rectangle per line. Pages
without text are listed in the result as `pagesWithoutText`, as for answers and summaries:
a scanned page cannot be checked, and the host should say so.

### 3.3 Patterns

Run on every device, always, with `source: 'rules'`. Each rule is a regular expression
plus a validator; a match that fails its validator is not a suggestion.

| Category | Match | Validator |
| --- | --- | --- |
| `iban` | two letters, two digits, 11–30 letters or digits, optional single spaces between groups | length 15–34 after removing spaces; ISO 13616 mod-97 remainder 1 |
| `email` | `local@domain.tld`, local part letters, digits and `._%+-`, TLD of 2+ letters | — |
| `phone` | `+` and 1–3 digit country code, then groups of digits separated by space, `-`, `.`, `/` or parentheses; or a national number: US `(212) 555-0142`, `212-555-0142`; UK `020 7946 0958`, `07700 900123`; German `030 12345678`, `030/1234567`, `0171 1234567` | 7–15 digits in total; not also a date, IBAN or card match |
| `paymentCard` | 13–19 digits in groups separated by single spaces or `-` | Luhn checksum |
| `date` | `2026-09-15`; `15.09.2026`, `15.9.26`; `09/15/2026`; `15 September 2026`, `September 15, 2026`, `15 Sep 2026`; `15. September 2026`, `15. Sept. 2026` — English and German month names and abbreviations, `März` included | a real calendar date (`31.02.2026` is not); two-digit years allowed only in the dotted form |
| `url` | `http://` or `https://` followed by non-space characters, or `www.` followed by a domain; trailing `.,;:)` excluded | — |
| `ipAddress` | IPv4 dotted quad; IPv6 full or `::`-compressed | each IPv4 octet 0–255; IPv6 at most 8 groups of 1–4 hex digits |

Matches must start and end on a word boundary, so `ABC12…` inside a longer token is not an
IBAN. When two pattern matches overlap, the longer one wins; on a tie, the order in the
table decides.

### 3.4 The model

Looks for `personName`, `postalAddress`, `dateOfBirth` and `idNumber`, through the fixed
route order of PRV-2: Apple's on-device model on iOS, then the custom provider if the host
configured one. Android has no on-device route (decision of 2026-09-15: provider only).
When no route is available the result carries `modelUsed: false` and the pattern
suggestions alone.

- The text is sent in chunks that fit the route's context, using the same budget rule as
  summaries. Each prompt names the four categories, asks for items copied word for word,
  and gives a JSON schema: `{ "items": [{ "category": …, "quote": … }] }`.
- **Every quote is verified** with the existing `locateQuote` against the chunk it came
  from. A quote not found there is dropped; a category outside the four is dropped.
- **Every occurrence is suggested.** Once a quote is verified, each exact occurrence of it
  on every page in scope becomes a suggestion of that category. A name mentioned five times
  is redacted five times.
- Quotes shorter than 3 characters are dropped, to avoid redacting every "Li" in a document.

A route that throws is handled as for answers: the next route is tried, and if none
answers the result is pattern-only with `modelUsed: false`.

### 3.5 Merging

A model suggestion that overlaps a pattern suggestion is dropped: the pattern is
deterministic and already covers that text. Suggestions with an identical page and range
are kept once.

## 4. Marks in the viewer

Generic, with no AI in them, so they live in the core and the core gains no AI dependency.

### 4.1 Headless viewer

```ts
viewer.setMarks([{ id, pageIndex, rects, state: 'pending' | 'accepted' | 'rejected' }]);
viewer.marks;                         // the current marks
viewer.markAt(pageIndex, point);      // the id of the topmost mark under a page point, or null
viewer.tapMark(pageIndex, point);     // cycles the tapped mark's state; returns its id, or null
viewer.setAllMarks(state);
```

`tapMark` rather than an event: the three components call it, so the cycling is one tested
behaviour per platform instead of three copies in UI code.

Marks are local to one viewer. They are not part of the sync wire and never touch the
document. Setting marks replaces the previous set.

### 4.2 UI components

| State | Drawn as |
| --- | --- |
| `pending` | orange outline, light orange fill |
| `accepted` | solid dark box — a preview of the redaction |
| `rejected` | faint dashed grey outline |

The components take an optional review setup:

```ts
PdfViewerElement.mount(element, document, {
  review: {
    marks,
    notice: 'Suggestions may be incomplete. Review the whole document.',
    applyLabel: 'Redact',
    onApply: (acceptedIds) => { … },
    onCancel: () => { … },
  },
});
```

SwiftUI: `PdfViewerView(document:review:)`. Compose: `PdfViewerView(document, review = …)`.

- Tapping a mark cycles pending → accepted → rejected → pending.
- A review bar shows the notice, the counts ("3 accepted · 1 pending"), **Accept all**,
  **Reject all**, **Apply** and **Cancel**. `notice` is required, so the RED-4 statement is
  always on screen.
- **Apply** passes the accepted ids to `onApply`; the component does not redact.
- While reviewing, editing tools are disabled, so a tap means a mark.

## 5. Applying and undo

### 5.1 Core: document snapshots

```ts
const snapshot = await document.snapshot();   // PdfDocumentSnapshot
const copy = await snapshot.open();           // a new PdfDocument as it was
```

A snapshot is the document's full serialisation, held privately. A snapshot lives until the
host drops it.

### 5.2 `apply`

```ts
const applied = await review.apply(acceptedIds);
applied.report;      // PdfRedactionReport from the core redact()
applied.remaining;   // accepted suggestions whose text is still found at their range
const restored = await applied.undo();   // a new PdfDocument, as it was before apply
```

1. Every id is checked first. An unknown id throws and nothing is written (HIL-1, as the
   existing proposal API does).
2. A snapshot is taken.
3. Each accepted suggestion's rectangles become `region` targets for one `redact()` call.
4. Each accepted suggestion's page text is read again; any whose text is still found at its
   range is listed in `remaining`. An empty list is the expected result; a non-empty one
   means the host must not report success.
5. `undo()` opens the snapshot (HIL-2). The host shows the returned document and closes the
   redacted one. The SDK cannot know when the host saves; the host drops `applied` then, and
   the documentation says so.

The document must still be saved with the full save mode for the removal to reach the file,
as for every redaction.

## 6. Testing

On all three platforms unless stated.

- **Shared test document.** `conformance/redaction/make-pii.mjs` writes
  `conformance/redaction/pii.pdf`: two pages of English and German text with a valid and an
  invalid IBAN, valid and invalid card numbers, emails, phone numbers in every supported
  format, dates in every supported format, URLs, IPv4 and IPv6 addresses, and person names,
  addresses, dates of birth and ID numbers for the model. `expected.json` lists every pattern
  suggestion (category, page, text). Each platform must produce exactly that list.
- **Patterns.** Unit tests per rule and validator, including near misses that must not
  match: a checksum-failing IBAN and card, an impossible date such as `31.02.2026`, `999.1.1.1`, a
  number of 6 digits, an IBAN embedded in a longer token.
- **Model, with a fake provider.** A made-up quote is dropped; a verified quote expands to
  every occurrence; a model suggestion overlapping a pattern is dropped; a throwing route
  falls back to patterns with `modelUsed: false`; no provider gives `modelUsed: false`.
- **Model, measured.** On iOS, the real on-device model through the simulator, on the shared
  document, English and German parts counted separately. The numbers go into the AI plan
  document and the README (the RED acceptance criterion).
- **Marks.** Headless: set, replace, hit test, tap event, and marks absent from the sync
  wire. UI: the web browser test, the Android Compose test and the iOS demo UI test each
  cycle a mark and press Apply.
- **Apply and undo.** Accepted text is absent from the saved bytes and rejected text present;
  `remaining` is empty; an unknown id writes nothing; `undo` restores the original text.
- **Snapshot.** Opening a snapshot of an edited document gives the edits.

## 7. Out of scope

- Smart form filling (the second half of Phase 2, next spec).
- Suggestions on scanned pages; OCR is not in the SDK.
- Languages beyond English and German for dates, phone formats and measurement.
- Server-side models and a server SDK.
- Persisting review state across app launches.
