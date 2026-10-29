# XFDF conformance case

Every SDK's `exportXfdf` and `importXfdf` is checked against these files.

| File | What it is |
|---|---|
| `make-xfdf.mjs` | Writes the two PDFs and `expected-export.xfdf` by hand, with no SDK. |
| `source.pdf` | Two pages. Fields: `customer.name` (hierarchical), check box `agree`, combo `country`, radio group `size` (S/M/L), text `ref` with a widget on each page, push button `submit`. Annotations: highlight, underline, strikeout, squiggly, ink, text note, square, circle, line, free text, stamp, a link, and a highlight with opacity 0.5 and no flags. |
| `source-blank.pdf` | The same fields, empty or off, and no annotations. |
| `expected-export.xfdf` | What `exportXfdf` must return for `source.pdf`, exactly. |
| `import.xfdf` | Imported into `source-blank.pdf`: values for every field, five annotations the SDKs can create, and elements that must be skipped. |
| `expected-import.json` | The report that import must return. |
| `expected-after-import.xfdf` | What `exportXfdf` must return after that import. |
| `malformed.xfdf`, `doctype.xfdf` | Must fail with `invalidOperation` and change nothing. |

`expected-export.xfdf` follows the canonical format in
`docs/superpowers/plans/2026-10-29-xfdf.md` (attribute order, number format, escaping).
