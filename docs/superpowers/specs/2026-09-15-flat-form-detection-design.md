# PdfiumKit — Flat Form Detection Design

Date: 2026-09-15
Status: Draft
Implements: FORM-7 of `2026-09-13-pdfiumkit-ai-requirements.md` (a MAY, marked "later")

## 1. Purpose

A PDF that was printed from a word processor has lines, boxes and underscores where a person is
meant to write, but no form fields. Propose fields for those places, let a person confirm them,
and create real fields, so the document can be filled in — including by smart form filling.

Success criteria:

- On the shared flat test form, every platform proposes exactly the expected fields (kind,
  rectangle within 1 pt, label), with no model, and none for a box that already holds text.
- The document written from the accepted proposals lists them as form fields with their labels
  as tooltips; a value set on a created text field and a created checkbox reads back after save
  and reopen; smart form filling proposes profile values for them.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Model | None: rules on page objects and characters, identical on every platform. The requirements expected image understanding; rules cover the common printed forms and a model can come later |
| Kinds | Text fields and checkboxes. No radio groups, combo boxes or signatures |
| Where fields go | Core `document.addFormFields`, through the writer (PDFium cannot create widgets) |
| Names | From the label, made unique; the label also becomes the tooltip (`/TU`) |
| Appearance | Text fields rely on `/NeedAppearances true` and `/DA`; checkboxes get `/Yes` and `/Off` appearance streams |
| Undo | `apply` returns a new document; the original is untouched |

## 3. Detection

On each page, from `page.objects()` and the page's characters:

1. **Underscore runs.** Five or more consecutive `_` characters in the page text. The candidate is
   the union of their character boxes, extended upward to a height of 14 pt (bottom kept).
2. **Lines.** Path objects whose bounds are at least 40 pt wide and at most 2 pt tall. The candidate
   sits on the line: its bottom is the line's bottom, height 14 pt.
3. **Boxes.** Path objects at least 40 pt wide and between 10 and 40 pt tall: a text field with the
   box's bounds.
4. **Squares.** Path objects with both sides between 6 and 16 pt and differing by at most 2 pt: a
   checkbox with the square's bounds.
5. **Occupied.** A candidate containing the centre of any character other than whitespace and `_`
   is dropped: it is a table cell or a label box, not a blank.
6. **Overlap.** Candidates are taken in rule order. One that intersects a candidate already kept is
   dropped, except that a box or square replaces a kept underscore run or line (a box drawn around
   an underline wins).
7. **Existing fields.** A candidate intersecting an existing widget's rectangle is dropped.
8. **Label**: the smart form filling label rule (text on the same line to the left within 250 pt,
   bounded by other candidates, else text just above within 14 pt), trailing `:` trimmed. For a
   checkbox the label may also be the text on the same line to the **right** within 250 pt, which
   is tried first. No label: the candidate is kept with label `""`.
9. **Order**: page, then top edge from the top of the page, then left edge.

## 4. Core: adding fields

```ts
const filled = await document.addFormFields([
  { pageIndex: 0, kind: 'text', rect, name: 'First name', tooltip: 'First name' },
  { pageIndex: 0, kind: 'checkBox', rect, name: 'I agree' },
]);   // a new PdfDocument
```

Gated as `forms`. `name` must be non-empty and not already a field name (existing or in the
call), otherwise `invalidOperation` and nothing written. Written as one incremental update:

- a widget dictionary per field (`/Type /Annot /Subtype /Widget /FT /Tx` or `/Btn`, `/T`, `/TU`
  when given, `/Rect`, `/F 4`, `/P`, `/DA (/Helv 0 Tf 0 g)`; checkboxes add `/V /Off`, `/AS /Off`
  and `/AP << /N << /Yes … /Off … >> >>` with a drawn tick);
- the page's `/Annots` gains the widgets (inline or referenced array, merged);
- the Catalog's `/AcroForm` (inline or referenced, merged) gains the fields, `/NeedAppearances
  true`, and `/DR << /Font << /Helv … >> >>` and `/DA` when absent.

## 5. API

```ts
const detected = await ai.forms.detect({ pages? });
detected.items;    // { id: "<pageIndex>:<n>", pageIndex, kind: 'text' | 'checkBox', rect, label }
detected.notice;   // "Check every field before it is added."
const withFields = await detected.apply(acceptedIds);   // PdfDocument
```

Names are the labels (whitespace collapsed); an empty or repeated label gets `Field <n>` or a
` 2`, ` 3` suffix. Unknown ids throw. Gated as `ai`.

## 6. Testing

- **Fixture.** `conformance/forms/make-flat.mjs` writes `flat.pdf` and `flat-expected.json`: an
  English page with an underscore run, a drawn line, a drawn box, a box around an underline, two
  checkbox squares with labels to their right, and a bordered box holding text.
- **Detection** on every platform: exactly the expected list.
- **addFormFields** on every platform: fields listed with names, tooltips and rectangles; text and
  checkbox values survive save and reopen; a duplicate name throws.
- **End to end**: detect, apply, then `forms.propose` with the test profile proposes the expected
  values for the created fields.
