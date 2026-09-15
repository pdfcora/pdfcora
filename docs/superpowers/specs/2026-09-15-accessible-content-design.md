# PdfiumKit — Accessible Content Design

Date: 2026-09-15
Status: Draft
Implements: A11Y-2 of `2026-09-13-pdfiumkit-ai-requirements.md` (the core accessibility track)

## 1. Purpose

Screen reader users hear a tagged PDF in the viewer components as it was structured:
headings announced as headings, list items as list items, figures by their alternate text,
tables as tables, form fields by their labels, in reading order.

Success criteria:

- On the shared tagged and remediated test documents, every platform produces the same
  accessible content tree for each page.
- The web component exposes it as semantic HTML; the SwiftUI component as accessibility
  elements with header and image traits in reading order; the Compose component as semantics
  nodes with heading and image roles in traversal order. Each is asserted by that platform's
  UI test.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Where the model lives | The core: `page.accessibleContent()`. No AI |
| Text of an element | PDFium's text page, character by character, assigned to marked-content ids through each character's text object; generated spaces and line breaks follow the previous character |
| Untagged pages | One paragraph per text line group is not attempted: the page's whole text is one paragraph node |
| Artifacts | Never exposed (they are not in the tree) |
| Form fields | Appended after the structure nodes, labelled by tooltip, else name; PDFium does not map `/OBJR` form elements |
| Positioning | Web: a visually hidden layer in reading order (not positioned). iOS and Android: elements placed at their bounds, so touch exploration finds them where they are drawn |
| Out of scope | A11Y-1 and A11Y-4 need an independent audit; A11Y-3 (keyboard, zoom) is separate work |

## 3. Core

```ts
const nodes = await page.accessibleContent();   // PdfAccessibleNode[]

interface PdfAccessibleNode {
  readonly role: 'heading' | 'paragraph' | 'list' | 'listItem' | 'figure' | 'table' | 'row'
    | 'headerCell' | 'cell' | 'formField';
  readonly level?: number;          // headings 1–6
  readonly text: string;            // the label to speak
  readonly bounds?: PdfRect;
  readonly children: readonly PdfAccessibleNode[];
}
```

### 3.1 Mapping structure types

`/S` as PDFium reports it (role maps not applied):

| `/S` | Node |
| --- | --- |
| `H1`–`H6` | `heading`, level from the digit |
| `H` | `heading`, level 1 |
| `P`, `Span`, `Quote`, `Code`, `Link`, `Note`, `Reference`, `BibEntry`, `Caption`, `TOCI`, `Lbl`, `LBody`, `Index` | `paragraph` |
| `L`, `TOC` | `list` |
| `LI` | `listItem` |
| `Figure`, `Formula` | `figure` |
| `Table` | `table`; `TR` → `row`; `TH` → `headerCell`; `TD` → `cell`; `THead`, `TBody`, `TFoot` → their children |
| anything else (`Document`, `Part`, `Sect`, `Div`, `Art`, `BlockQuote`, `NonStruct`, …) | no node of its own: its children take its place, preceded by a `paragraph` for its own text if it has any |

### 3.2 Text and children

- **Own text**: the characters whose marked-content id is one of the element's own ids, in text
  order, whitespace collapsed, trimmed.
- `heading`, `paragraph`, `listItem`, `headerCell`, `cell`: `text` is the element's own text
  followed by all its descendants' text, joined by a space; `children` is empty. `/ActualText`
  replaces it.
- `figure`: `text` is `/Alt`, else `/ActualText`, else the text as above; no children.
- `list`, `table`, `row`: `text` is empty; `children` are the mapped children.
- A node with empty text and no children is dropped, except `figure` (a figure without
  alternate text is still announced as an image).
- `bounds` is the element's bounds from `structure()`.

### 3.3 Untagged pages and form fields

A page whose structure is empty gives one `paragraph` with the page's whole text (whitespace
collapsed) and the page's bounds, if the text is not empty. Then, for every page, each form
field widget on it is a `formField` node, in annotation order, with text = tooltip, else name,
and the widget's rectangle.

## 4. Components

- **Web.** The canvas gets `aria-hidden="true"`. A sibling `div` with class `pdf-accessible-content`,
  visually hidden (1 px clip, not `display: none`), is rebuilt on every page change: `h1`–`h6`,
  `p`, `ul`/`li`, `div role="img" aria-label`, `table`/`tr`/`th`/`td`, and `div role="group"
  aria-label` for form fields.
- **iOS.** The page image is `accessibilityHidden`. For each node, depth first, a clear view at the
  node's bounds with `accessibilityLabel(text)`; `.isHeader` for headings, `.isImage` for figures;
  `accessibilityHint` "list item", "table cell" or "form field" by role. Sort priority keeps
  reading order.
- **Android.** The page image has `clearAndSetSemantics {}`. For each node, a `Box` at its bounds
  with `semantics { contentDescription = text; heading() for headings; role = Role.Image for
  figures; stateDescription "list item" / "table cell" / "form field"; traversalIndex = order }`.

Nested nodes (lists, tables, rows) contribute their leaves; containers are not separate elements
on iOS and Android, where touch exploration works on leaves.

## 5. Testing

- **Core**, every platform, on `conformance/alt-text/tagged.pdf` page 0: `heading 1 "Annual report
  2026"`, `paragraph`, `figure "Bar chart of revenue by region"`, `paragraph "Figure 1: …"`,
  `figure ""` (photo), …; on the remediated document written by the remediation test: a `list`
  with three `listItem`s whose text starts with "•"; on `hello_world.pdf` one paragraph; on
  `text_form.pdf` a `formField`.
- **Web** browser test: the viewer element on the tagged document has an `h1` with the title, a
  `role="img"` with the chart's label, and the canvas is `aria-hidden`.
- **iOS** demo UI test: a demo screen showing the tagged document exposes an element
  labelled "Annual report 2026" and an image labelled "Bar chart of revenue by region".
- **Android** Compose test: the same, as a heading node and an image node.
