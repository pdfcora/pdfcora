# PdfiumKit — Semantic Diff Design

Date: 2026-09-15
Status: Draft
Implements: "Semantic document diff" of `2026-09-13-pdfiumkit-ai-requirements.md` §14

## 1. Purpose

Compare two versions of a document, show what changed in both, and say which changes alter the
meaning and which only reword it.

Success criteria:

- On the shared pair of test documents, every platform finds exactly the expected unchanged,
  modified, added and removed sentences, with no model.
- With a model, each modified pair is labelled `meaningChanged` or `wordingOnly`, and meaning
  changes get a one-sentence summary; a model answer that is not one of the two labels is ignored.
- Every change carries character ranges and rectangles on its page in each version, for marks.

## 2. Decisions

The owner asked for no confirmation rounds.

| Question | Decision |
| --- | --- |
| Unit of comparison | Sentences, from the existing `sentencesOf` on each page's text, as answers use |
| Alignment | Deterministic, no model: longest common subsequence over normalised sentences, then pairing inside the gaps |
| Model | Labels modified pairs and summarises. Routes: Apple's on-device model, then the custom provider on iOS; the custom provider on Android and web (their prompt APIs are alpha) |
| Added and removed sentences | Always `meaningChanged`, no model call |
| Review | Marks on each version in two viewers, which the host lays out |
| Language | Any: the alignment is language-neutral; the prompt is English and asks for the summary in the documents' language |

## 3. Alignment

1. **Sentences.** For each version, every page's sentences in order, each with page index, start,
   end and text.
2. **Normalising** for comparison: lower-case, every run of whitespace to one space, trimmed,
   typographic quotes and dashes folded to ASCII (`‘’` → `'`, `“”` → `"`, `–—` → `-`).
3. **Anchors.** The longest common subsequence of the two normalised sentence lists. Anchored pairs
   are `unchanged` and not reported.
4. **Gaps.** Between consecutive anchors (and before the first and after the last), the unmatched
   sentences of each side, in order. Walk both gap lists: while both have a sentence left and the
   similarity of the two heads is at least 0.3, pair them as `modified`; when the similarity is
   lower, the original head is reported `removed` when the revised head is at least as similar to
   the original's *next* sentence as the original head is to the revised's next (a missing next
   sentence has similarity 0); otherwise the revised head is reported `added`. Leftovers are
   `removed` / `added`.
5. **Similarity**: Dice coefficient of the sets of character trigrams of the normalised texts,
   with spaces as characters (`2·|A∩B| / (|A|+|B|)`); two empty sets are 0.
6. **Order** of the reported changes: the order the walk reports them, gap by gap from the start
   of the documents.

## 4. Labelling

For each `modified` pair, one request with both sentences, asking for
`{ "label": "meaningChanged" | "wordingOnly", "summary": string }` — the summary one sentence,
only for meaning changes. The answer is used when `label` is one of the two; otherwise the pair
stays `unclassified`. A `meaningChanged` label with an empty summary keeps the label and gets no
summary. Without a route, or when every route fails, modified pairs are `unclassified` and
`modelUsed` is false. Model text passes through the AI trial prefix.

## 5. API

```ts
const diff = await ai.diff.compare(revised, { pages?, revisedPages? });   // ai.document is the original
diff.changes;      // PdfDiffChange[]
diff.modelUsed;
diff.notice;       // "Check the differences against both documents."

interface PdfDiffChange {
  readonly id: string;                       // "c<n>", in order
  readonly kind: 'modified' | 'added' | 'removed';
  readonly label: 'meaningChanged' | 'wordingOnly' | 'unclassified';
  readonly summary?: string;
  readonly original?: PdfDiffSide;           // absent for added
  readonly revised?: PdfDiffSide;            // absent for removed
  readonly source: 'rules' | 'onDevice' | 'customProvider';
}

interface PdfDiffSide {
  readonly pageIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly rects: readonly PdfRect[];
}
```

`source` is `rules` for added, removed and unclassified changes. Gated as `ai`.

## 6. Testing

- **Fixture.** `conformance/diff/make-versions.mjs` writes `original.pdf`, `revised.pdf` and
  `expected.json`: a two-page tenancy agreement where the revision rewords one sentence, changes
  a number in another, adds a sentence, removes a sentence, and moves nothing else.
- **Alignment** on every platform: exactly `expected.json` (kind, original text, revised text).
- **Similarity**: shared cases in `conformance/diff/similarity.json`.
- **Labelling** with a fake provider: its labels and summaries are used; an invalid label leaves
  `unclassified`; a throwing provider leaves `unclassified` with `modelUsed` false; added and
  removed changes never reach the provider.
- **iOS**: Apple's on-device model measured on the fixture's modified pairs (opt-in, as for
  redaction), recorded in the AI plan document.
