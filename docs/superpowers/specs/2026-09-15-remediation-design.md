# PdfiumKit — Remediation Design

Date: 2026-09-15
Status: Implemented 2026-09-15
Implements: REM-1 and REM-2 of `2026-09-13-pdfiumkit-ai-requirements.md` (AI Phase 3, second half)

## 1. Purpose

Tag an untagged PDF: propose headings, paragraphs, list items, figures and artifacts in a
reading order, show them for review, and write what a person confirms as a structure tree,
so that a document with embedded fonts can pass PDF/UA-1 once its figures are described.

Success criteria:

- On the shared untagged test document, every platform proposes exactly the expected blocks,
  types and order, with no model.
- The document written from those proposals, with its figure then described through the alt
  text feature, passes veraPDF's PDF/UA-1 profile on all three platforms.
- Nothing is written until `apply`; the original document is unchanged.

## 2. Decisions

The owner asked for no confirmation rounds.

| Question | Decision |
| --- | --- |
| Model | None. Blocks, types and order come from rules on the page objects, identically on every platform. A small model adds no measured benefit here and would make results differ by device |
| Tables | Not proposed; table text becomes paragraphs. Tagging tables needs cell structure the rules cannot infer reliably |
| Reading order | Content-stream order of each block's first object. Multi-column layouts drawn out of order are not reordered; the reviewer sees the numbers |
| Vector graphics | Paths and shadings are artifacts. A chart drawn with paths is therefore not announced; noted in the review |
| Figures | Images and form XObjects, except those the alt text decorative rule matches, which are artifacts. Descriptions come from the alt text feature afterwards |
| Annotations, form fields | Not tagged. A page with annotations will not pass PDF/UA after remediation |
| Headings | Levels come from font size, then are renumbered in reading order so the first is H1 and none is skipped (PDF/UA 7.4.2). Added 2026-09-16 after the real-world survey |
| Already tagged | Refused: `alreadyTagged` and nothing proposed |
| Metadata | A new XMP packet (title, `pdfuaid:part 1`) replaces any existing one |
| Undo | `apply` returns a new document; the original is untouched |

## 3. Core: tagging content

```ts
const tagged = await document.tagContent(blocks, { title?, language? });   // a new PdfDocument

interface PdfTagBlock {
  readonly pageIndex: number;
  readonly type: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'P' | 'LI' | 'Figure' | 'Artifact';
  readonly objectIndices: readonly number[];   // indices from page.objects()
  readonly altText?: string;                   // Figure only
}
```

Blocks are in reading order. Gated as `editing`. Checked before anything is written, each
failure `invalidOperation`: the document is already tagged; a page index is out of range; an
object index is out of range or appears in two blocks; `altText` on a non-figure; no title
(neither given nor in the document's metadata); no language (neither given nor in `/Lang`).

1. **Marking, in PDFium** (a scratch copy of the document, saved in full without the
   watermark). On each page, objects are visited in block order; every object of a block gets
   a content mark named after the block type (`LBody` for list items) with an `MCID`
   parameter, one new id per object, counted from 0 per page. Objects in `Artifact` blocks and
   objects in no block get an `Artifact` mark. `FPDFPage_GenerateContent` rewrites the page;
   the copy is saved in full.
2. **The tree, through the writer**, appended to those bytes:
   - `StructTreeRoot` with `/K` a `Document` element, `/ParentTree` (a number tree with one
     array per page, indexed by MCID) and `/ParentTreeNextKey` = page count;
   - one element per block (`/S`, `/P`, `/Pg`, `/K` the block's MCIDs, `/Alt` when given);
     consecutive `LI` blocks share one `L`, each as `LI` → `LBody` holding the MCIDs;
   - each page gains `/StructParents` (its index) and `/Tabs /S`;
   - the Catalog gains `/StructTreeRoot`, `/MarkInfo << /Marked true >>`, `/Lang`,
     `/ViewerPreferences` with `/DisplayDocTitle true` merged into any existing ones, and
     `/Metadata`, a new XMP stream with `dc:title` and `pdfuaid:part` 1.
3. The bytes open as the new document, which needs the watermark if the original did.

## 4. Proposals

### 4.1 API

```ts
const review = await ai.remediation.suggest({ pages? });
review.alreadyTagged;
review.blocks;        // PdfRemediationBlock[] in reading order
review.notice;        // "Check every tag and the reading order before they are written."
const tagged = await review.apply({ types?: { [id]: type }, language?, title? });

interface PdfRemediationBlock {
  readonly id: string;                     // "<pageIndex>:<first object index>"
  readonly order: number;                  // 1-based across the document
  readonly pageIndex: number;
  readonly type: PdfTagBlock['type'];
  readonly objectIndices: readonly number[];
  readonly rect: PdfRect;
  readonly text: string;                   // for review; empty for figures and artifacts
}
```

`types` overrides a block's type; an unknown id throws. `title` defaults to the first `H1`'s
text, else the first heading's. `apply` calls `tagContent` with every block of the proposal,
so all content is either tagged or an artifact. Review uses the viewer marks with the label
`"<order> <type>"`. Proposing is gated as `ai`.

### 4.2 Rules

On the pages in scope, from `page.objects()`:

1. **Body size**: the font size carrying the most characters over the text objects in scope,
   rounded to 0.5 pt; a tie goes to the smaller size.
2. **Lines**: text objects with non-blank text, in object order. An object joins the current
   line when its font size is within 0.5 pt of the line's, its vertical extent overlaps the
   line's by at least half the smaller height, and it starts no more than one font size left
   of the line's right edge. Otherwise it starts a line.
3. **Blocks**: a line joins the current text block when the block is the last block on the
   page, the font sizes are within 0.5 pt, the gap from the block's bottom to the line's top is
   at most half the font size, the left edges are within one font size, and the line does not
   start with a list marker. Otherwise it starts a block. A non-text object always ends the
   current text block.
4. **List marker**: text starting with `•`, `◦`, `▪`, `‣`, `-`, `–` or `*` followed by a space,
   or one to three digits or one letter followed by `.` or `)` and a space.
5. **Text block type**: a block whose first line starts with a list marker is `LI`. Otherwise,
   one whose font size is at least 1.2 × the body size and whose text is at most 200 characters
   is a heading: the distinct heading sizes in scope, largest first, are `H1`, `H2`, … `H6`
   (sizes beyond six are `H6`). Everything else is `P`.
6. **Other objects**, each its own block: `image` and `form` are `Figure`, unless the alt text
   decorative rule matches their bounds (shorter side ≤ 3 pt, or area ≤ 100 pt²), then
   `Artifact`; `path`, `shading` and `unknown` are `Artifact`.
7. **Order**: pages ascending; on a page, blocks by their first object's index.

A block's `text` is its lines joined by a space. `rect` is the union of its objects' bounds.

## 5. Testing

- **Fixture.** `conformance/remediation/make-untagged.mjs` writes `untagged.pdf` (two pages,
  Liberation Sans embedded, no tags, no title, no language) and `untagged-expected.json`: 14
  blocks with type, object count and text, including a two-line paragraph, bulleted and
  numbered lists, a photo and a thin rule.
- **Core** on every platform: `tagContent` with the expected blocks writes a document whose
  `structure()` has `Document` → `H1`, `P`, `H2`, `L` (3 `LI`), …; `isTagged()` is true; the
  original is unchanged; every refusal in §3 throws and writes nothing; a trial document's
  result stamps once.
- **Proposals** on every platform: exactly `untagged-expected.json`; an override changes a
  type; an unknown id throws; a tagged document reports `alreadyTagged`.
- **PDF/UA.** Remediate the fixture, describe its figure with `updateFigures`, save: veraPDF
  PDF/UA-1 passes (web in CI; iOS and Android in the local gates).

## 6. Out of scope

- Tables, multi-column reading order, tagging annotations and form fields.
- Documents without embedded fonts passing PDF/UA (remediation still tags them).
- Language detection: the host passes the language when the document has none.
