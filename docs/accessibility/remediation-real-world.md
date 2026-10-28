# Remediation against real-world PDFs

Date: 2026-09-16 · Corpus: 238 public documents · Judge: veraPDF 1.30.2, PDF/UA-1

Until now, remediation was proven on one hand-written fixture and a no-crash sweep of
PDFium's test files. This is the first run against documents nobody wrote for us.

## How to repeat it

```bash
./scripts/fetch-real-world-corpus.sh          # ~175 MB into ~/pdfcora-corpus/real-world
node scripts/remediation-survey.mjs           # writes build/remediation-survey.json
```

Nothing from the corpus is committed: it is third-party material, fetched on demand. The
survey opens each document, records whether it is tagged already and whether it has a text
layer at all, runs `remediation.suggest()` and `apply()`, saves the result and validates it
with veraPDF.

## What the corpus is

| Source | Documents | Why |
| --- | --- | --- |
| CUAD contracts (SEC filings) | 15 | Real contracts, English |
| arXiv papers and EU Official Journal acts (EN and DE) | 16 | Multi-column, two languages |
| Bundesbank monthly report, Destatis and LAIV-MV statistical reports | 6 | Table-heavy, German |
| SIX QR-bill style guide | 1 | Invoices |
| GovDocs1 subset 000 | 200 | A realistic mix of forms, reports and letters |

EU Official Journal acts come from the Publications Office's own endpoint: the EUR-Lex web
pages refuse automated requests. The German federal forms portal is a JavaScript
application and was not scraped, so forms are represented only by GovDocs1.

## What happened

| Documents | 238 |
| --- | --- |
| Opened without error | 238 |
| Tagged already, so refused | 61 |
| Scanned, no text layer | 4 |
| Refused with a typed error | 13 |
| **Remediated** | **160** |
| …PDF/UA-1 compliant afterwards | 9 |
| …still not compliant | 151 |

6,146 pages. 762,178 blocks proposed, in 11 s of `suggest` and 20 s of `apply` for the
whole corpus — speed is not the problem. The slowest single document is 76 pages and
18,823 blocks in 1.5 s.

| Source | Documents | Tagged already | Remediated | Compliant |
| --- | --- | --- | --- | --- |
| CUAD contracts | 15 | 0 | 15 | 0 |
| GovDocs1 | 200 | 46 | 150 | 9 |
| SIX invoice guide | 1 | 0 | 1 | 0 |
| arXiv and EU OJ | 16 | 10 | 6 | 0 |
| German reports | 6 | 5 | 1 | 0 |

**A quarter of the corpus was already tagged** and correctly refused: every EU Official
Journal act, most arXiv papers and five of six German statistical reports. Contracts never
are. A product that assumes documents need remediation would be wrong a quarter of the time.

**Why the other 151 are not compliant.** Of them, 129 fail *only* on things remediation
does not claim to do, or cannot:

| Clause | Documents | What it is |
| --- | --- | --- |
| 7.21.4.1-1 | 105 | The source document's fonts are not embedded |
| 7.3-1 | 86 | A figure has no alternate text |
| 7.21.7-1 | 39 | A font has no ToUnicode map |
| 7.18.1-2 | 23 | An annotation has no `Contents` or `Alt` |
| 7.21.3.2-1 | 21 | An embedded CIDFont has no `CIDToGIDMap` |
| 7.18.5-1, 7.18.5-2 | 14 | Links are not tagged and have no description |
| 7.21.5-1 | 12 | Glyph widths disagree with the embedded font program |

The font clauses are properties of the file as it arrived: no amount of tagging embeds a
font, so those documents cannot reach PDF/UA through remediation at all. Figures and
annotations are the design's stated gaps.

**22 documents fail on something else, and that is the work list:**

| Clause | Documents | What it is | Status |
| --- | --- | --- | --- |
| 7.1-1, 7.1-2 | 12 | Artifact inside tagged content, and the reverse | Diagnosed, not fixed |
| 7.1-3 | 3 | Content neither tagged nor an artifact | Open |
| 7.11-1 | 2 | Optional content without a `Name` | Open |
| 7.10-1, 7.21.6-x, 7.21.7-2 | 5 | Assorted font and structure rules | Open |

The 7.1-1/7.1-2 pair has a known cause: the page's own content stream already contains
marked content, and tagging adds its own marks around those objects, so the spans nest and
an artifact ends up inside tagged content. `FPDFPageObj_GetMarkedContentID` already reports
an existing id, so the fix is to notice it before marking. Not attempted here.

## What this changed

A defect found only because real documents were used, fixed on all three platforms in
the same commit as this report.

**Heading levels started below H1 and skipped.** Levels were assigned by font size alone,
so a document whose largest line is not its first heading — a total set large, an oversized
page number — began at H2 or H3, which PDF/UA 7.4.2 forbids. Headings are now renumbered in
reading order so the first is H1 and no level is skipped, keeping the relative hierarchy.
`conformance/remediation/heading-order.pdf` is the fixture; all three platforms assert it.

## What remediation still cannot do

Ranked by how often the corpus hit them.

1. **Figures have no alternate text** (7.3-1). Remediation tags a figure; describing it is
   the alt text feature's job, and on most devices a person's. A document of scanned page
   images therefore needs hundreds of descriptions.
2. **The source document's fonts are not embedded** (7.21.4.1, 7.21.3.2, 7.21.5, 7.21.7).
   Tagging cannot fix this: the file would have to be rewritten with embedded fonts. Any
   document in this state can never reach PDF/UA, whatever we tag.
3. **Annotations and links are not tagged** (7.18.1, 7.18.5) — as the design says.
4. **Encrypted documents are refused**: `cannot append to an encrypted document`.
5. **Scanned pages** have no text layer, so there is nothing to tag. The SDK has no OCR.
6. **Tables become paragraphs and vector charts become artifacts**, as the design says;
   veraPDF cannot see either, so the numbers above understate how much a person would fix.
