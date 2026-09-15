# PdfiumKit — Alt Text Design

Date: 2026-09-15
Status: Draft
Implements: ALT-1 to ALT-4 and HIL-1 to HIL-3 of `2026-09-13-pdfiumkit-ai-requirements.md`
(AI Phase 3, first half; remediation follows in its own spec)

## 1. Purpose

Find the figures in a tagged PDF that have no alternate text, propose a description (or, for
a figure that is only decoration, marking it as an artifact), and write what a person
confirms into the document so that it passes PDF/UA-1.

Success criteria:

- On the shared tagged test document, every platform lists exactly the three figures without
  alternate text, and proposes the thin rule as decorative with no model.
- A document written from confirmed proposals passes veraPDF's PDF/UA-1 profile; the test
  document before the change fails only rule 7.3-1, three times.
- Nothing is written until `apply`; the original document is left unchanged.

## 2. Decisions

The owner asked for no confirmation rounds; these follow the requirements and the Phase 2
designs.

| Question | Decision |
| --- | --- |
| Documents | Tagged PDFs only. An untagged document reports `untagged` and lists nothing; tagging it is remediation (REM) |
| Which figures | Structure elements whose `/S` is `Figure` with neither `/Alt` nor `/ActualText` (blank counts as none) and with marked content on the page. Role-mapped types are not resolved: PDFium does not expose `/RoleMap` |
| Identity of a figure | Page index plus its marked-content ids. PDFium's structure elements have no object numbers; the writer finds the same element by walking the tree itself |
| Decorative | By rules: shorter side ≤ 3 pt, or area ≤ 100 pt². The provider may also answer decorative |
| Writing a description | `/Alt` on the element, appended as an incremental update |
| Writing decorative | The element's content is re-marked `/Artifact` by PDFium (content regenerated) and the element is removed from its parent's `/K` |
| Model routes | Custom provider on iOS and web (Apple's model is text-only). Android: ML Kit GenAI Image Description (English, beta) first, then the provider |
| Review | The existing viewer marks, labelled with the proposed text or "Decorative" |
| Undo | `apply` returns a new document; the original is untouched, so keeping it is the undo |
| Validation | veraPDF PDF/UA-1 on the written test documents, in CI |

## 3. Core: reading the structure tree

```ts
const tagged = await document.isTagged();          // FPDFCatalog_IsTagged
const roots = await page.structure();              // PdfStructureElement[]

interface PdfStructureElement {
  readonly type: string;                  // /S as written
  readonly altText?: string;
  readonly actualText?: string;
  readonly title?: string;
  readonly language?: string;
  readonly markedContentIds: readonly number[];
  readonly bounds?: PdfRect;              // union of page objects carrying this element's
                                          // or its descendants' marked-content ids
  readonly children: readonly PdfStructureElement[];
}
```

Wraps `FPDF_StructTree_GetForPage` and `FPDF_StructElement_*`. Empty strings read as absent.
Marked-content ids of `-1` (children that are elements) are not listed. Bounds come from
one pass over the page's top-level objects with `FPDFPageObj_GetMarkedContentID`. The same
read serves the accessible viewer track (A11Y-2) later.

## 4. Core: writing figures

```ts
const updated = await document.updateFigures([
  { pageIndex: 0, markedContentIds: [4], altText: 'A photo of an office building at dusk' },
  { pageIndex: 0, markedContentIds: [6], decorative: true },
]);   // a new PdfDocument; `document` is unchanged
```

Gated as the `editing` license module. Every edit is resolved before anything is written;
one that matches no figure, or more than one, throws `invalidOperation` and nothing is
written (HIL-1).

1. **Decorative, in PDFium.** On the edit's page, every top-level object whose content mark
   carries an `MCID` in the edit's ids loses that mark and gains an `Artifact` mark;
   `FPDFPage_GenerateContent` then rewrites the page.
2. **Base bytes.** The document is serialised without the trial watermark — in full when
   step 1 changed a page (an incremental save drops regenerated content), incrementally
   otherwise, so existing signatures keep verifying for description-only edits.
3. **Finding the element.** The writer walks `/Root /StructTreeRoot /K` depth-first (at most
   64 levels, each object once). An element's page is its `/Pg`, else its parent's. Its ids
   are the integers in `/K` and the `/MCID` of marked-content reference dictionaries in `/K`
   (whose own `/Pg` wins). A match has `/S /Figure`, the edit's page, and exactly the edit's
   ids. The element must be an indirect object.
4. **Rewriting.** A description sets `/Alt` on a copy of the element dictionary. Decorative
   removes the element's reference from its parent's `/K` (an inline array or a single
   reference; an indirect `/K` array object is rewritten as that object). The objects are
   appended with the existing `appendUpdate`.
5. **Reopening.** The bytes open as the new document, which needs the watermark if the
   original did.

**Reader fix this depends on.** The writer's dictionary readers returned literal strings as
their escaped source text and, on web, hex strings as a placeholder object, so re-serialising
a dictionary holding either corrupted it. Structure elements routinely hold `/T`, `/Lang` and
`/ActualText`. Literal strings now read as raw bytes written back verbatim, and hex strings
as bytes, on all three platforms. The same bug could corrupt a Catalog or page with strings
when signing; the fix covers that too.

## 5. Alt text proposals

### 5.1 API

```ts
const review = await ai.altText.suggest({ pages? });
review.untagged;      // true: nothing listed, the document needs tags first
review.items;         // PdfAltTextProposal[]
review.modelUsed;
review.notice;        // "Check every description before it is written."

interface PdfAltTextProposal {
  readonly id: string;                    // "<pageIndex>:<ids joined by ,>"
  readonly pageIndex: number;
  readonly markedContentIds: readonly number[];
  readonly rect: PdfRect;
  readonly kind: 'description' | 'decorative';
  readonly text: string;                  // empty when no route proposed one
  readonly source: 'rules' | 'onDevice' | 'customProvider' | null;
  readonly context: string;               // the page text used as context
}

const updated = await review.apply([{ id, text?, decorative? }]);   // PdfDocument
```

Suggesting is gated as `ai`; writing goes through `updateFigures`, gated as `editing`. Items
are ordered by page, then by the figure's top edge from the top of the page, then left edge.

### 5.2 Finding and proposing

For each page in scope: `structure()`, flattened; figures per §2 with bounds.

- **Decorative by rules** (§2): `kind: 'decorative'`, `source: 'rules'`, no model call.
- **Context**: the page's characters whose box centre lies between 48 pt below the figure's
  bottom and 48 pt above its top, across the page width, in text order, whitespace collapsed, at most 500 characters.
- **Image**: the page rendered so the figure's longer side is at most 512 px (scale capped at
  4), cropped to the figure, PNG-encoded.
- **Routes**, in order, until one answers:
  - Android only: ML Kit Image Description on the image, when available and the device is in
    the foreground. It returns a description; it never proposes decorative.
  - Custom provider: one request per figure with the image and a prompt naming the context,
    asking for one sentence of at most 150 characters that says what the figure shows and
    why it matters in context, or decorative when it adds no information. Schema:
    `{ "decorative": boolean, "description": string }`. A blank description that is not
    decorative is no answer.
- No route answering leaves `kind: 'description'`, `text: ''`, `source: null`: the figure is
  still listed for a person to describe (ALT-1, ALT-2). A route that throws moves on to the
  next, as for every other feature.
- Model text passes through the AI trial prefix.

### 5.3 Apply

Every decision is checked first: an unknown id throws; a decision whose resulting kind is
`description` with blank text throws; nothing is written. A decision's `text` replaces the
proposal's (ALT-2 edit); `decorative` overrides the kind (ALT-3). Rejected items are simply
not passed. The result is `document.updateFigures(...)`.

### 5.4 Review in the viewer

Hosts pass the proposals as marks (`id`, `pageIndex`, `rects: [rect]`, `label`: the text or
"Decorative") with the notice to the existing review components; `onApply` receives the
accepted ids. Editing a description is the host's UI; the SDK takes the edited text in
`apply`.

## 6. Testing

- **Fixture.** `conformance/alt-text/make-tagged.mjs` writes `tagged.pdf`: two pages, an H1,
  H2 and paragraphs, a vector chart figure with `/Alt`, a photo figure without, a 2 pt rule
  figure without, and on page 1 a logo figure reached through a marked-content reference
  dictionary. Liberation Sans is embedded (OFL). `tagged-expected.json` lists the figures.
  veraPDF on it: only 7.3-1, three failed checks.
- **Structure read** on every platform: the page 0 tree (Document → H1, P, Figure…) with ids,
  alt text and bounds inside the drawn rectangles.
- **Writer** unit tests on web: an element with a literal string holding escapes and a hex
  string survives a rewrite byte-identical in those values; an element in an object stream (the signed
  `signed_unh_iol.pdf`) is found and rewritten and the signature still verifies; an ambiguous or missing match throws.
- **updateFigures** on every platform: after writing descriptions for both photo figures and
  decorative for the rule, `structure()` on the result shows the alt texts and no rule figure,
  the rule's page object carries an `Artifact` mark, and the original document is unchanged.
  A trial document's result reopens watermarked and stamps once on save.
- **Proposals** on every platform: no provider → the three expected figures, the rule
  decorative by rules, the others with empty text, contexts containing their captions; a fake
  provider receives one PNG per described figure and its answer is used; a provider answering
  decorative is honoured; a throwing provider leaves empty text; an untagged document reports
  `untagged`; `apply` with an unknown id or blank description throws.
- **PDF/UA.** The web test writes `build/alt-text/written.pdf`; iOS and Android tests write
  theirs to their test output. `scripts/verapdf-ua1.sh <files>` runs veraPDF and fails on any
  failed rule; CI runs it on the web output, and the local gates on all three.

## 7. Out of scope

- Untagged documents (remediation, next spec) and role-mapped figure types.
- Figures without marked content (object references only).
- Languages for ML Kit other than English; an on-device image model on Apple or web.
- A text editor for descriptions inside the review components.
