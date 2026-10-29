# XFDF export and import

Date: 2026-10-29

## Intent

Apps need to move annotations and form values in and out of a PDF without moving the PDF:
to exchange them with other PDF tools (Acrobat, Apryse, PDF.js-based viewers), and to keep
them in their own backend. XFDF (ISO 19444-1, Adobe's XML Forms Data Format) is the common
format for that. PDFium has no XFDF support, so the SDK writes and reads the XML itself, on
top of the annotation and form APIs it already has.

## Goals

1. `exportXfdf` on a document returns an XFDF string with the document's form field values
   and its annotations.
2. `importXfdf` applies an XFDF string to a document: it sets form field values and creates
   the annotations the SDK can create, and returns a report of what it applied and what it
   skipped, with a reason for each skipped element.
3. Same behaviour on iOS, Android, Web, Node (through Web) and Java, checked by one shared
   conformance case like every other cross-platform feature.

## Non-goals

- FDF (the binary-ish predecessor of XFDF).
- Creating annotation types the SDK cannot create today (see Import). They are reported,
  never silently dropped.
- Merging or conflict handling: import adds annotations; it does not match, update or
  delete existing ones.
- Appearance streams in XFDF (`<appearance>`), rich text (`<contents-richtext>`), replies
  and review states (`inreplyto`, `state`), `<ids>`, JavaScript, and `<f href>`. Export does
  not write them; import ignores them silently and counts the annotation as added (rich
  text falls back to plain `contents` when present). The docs list what is ignored.
  *(Designer's call.)*

## Anti-goals

- No XML library dependency on any platform beyond what the platform ships.
- An XFDF file from outside is untrusted input: no external entities, no DTD processing, no
  network or file access while parsing, a size limit, and malformed XML fails with a typed
  error instead of a crash or a partial write.
- Import must not half-apply because of bad input: it parses and validates the whole file
  first, then writes. PDFium has no transactions, so a write that still fails after
  validation (a field that will not take a value, an annotation PDFium will not create) is
  reported as `writeFailed` and import continues; there is no rollback. *(Designer's call.)*

## API (all platforms; idiomatic names)

| Platform | Export | Import |
|---|---|---|
| Web/Node | `document.exportXfdf(): Promise<string>` | `document.importXfdf(xml: string): Promise<PdfXfdfReport>` |
| iOS | `func exportXFDF() async throws -> String` | `func importXFDF(_ xml: String) async throws -> PdfXfdfReport` |
| Android | `suspend fun exportXfdf(): String` | `suspend fun importXfdf(xml: String): PdfXfdfReport` |
| Java | `String exportXfdf()` | `PdfXfdfReport importXfdf(String xml)` |

`PdfXfdfReport`: `fieldsSet` (count), `annotationsAdded` (count), and `skipped` — a list of
`{ element, page?, reason }` where `element` is the XFDF element name (e.g. `square`,
`field`) and `reason` is one of a closed set: `unsupportedType`, `unknownField`,
`readOnlyField`, `invalidValue`, `pageOutOfRange`, `missingAttribute`, `writeFailed`.

Errors (existing `PdfError` cases, no new code): malformed XML, a root that is not `xfdf`,
input over the size limit, or the document is closed → `invalidOperation` with a message
(Java: `INVALID_OPERATION`). Nothing is written when an error is raised.

## Export: what is written

```xml
<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
  <fields>…</fields>
  <annots>…</annots>
</xfdf>
```

- **Fields:** the SDKs list fields per widget, so widgets that share a full name are one
  XFDF field, written once, in the order the first widget appears (page, then annotation
  index). A radio group's value is the export value of the widget that is on, or `Off`. A
  text field shown on several pages takes the first widget's value. *(Designer's call.)*
  One `<field name="…"><value>…</value></field>` per named field with a value:
  text (its value), check box / radio (its export value when on, `Off` when off), combo and
  list box (the selected option texts; one `<value>` per selection). Hierarchical names
  (`a.b.c`) are written as nested `<field>` elements, as the spec requires. Push buttons and
  signature fields are not written. A field with no name is skipped.
- **Annotations:** every annotation except widgets (they are the fields) and links (XFDF
  carries them only by convention and other tools ignore them). Common attributes on every
  element: `page` (0-based), `rect` (`x1,y1,x2,y2` in PDF space), `color` (`#RRGGBB`, when
  set), `flags` (the XFDF flag names, comma-separated, from the PDF flags), `name` (`/NM`),
  `title` (`/T`, the author), `date` and `creationdate` (`/M`, `/CreationDate`, kept in PDF
  date syntax), `opacity` (`/CA`, when not 1), and `<contents>` (when present).
- **Per type:**
  - `highlight`, `underline`, `strikeout`, `squiggly`: `coords` (the quad points).
  - `ink`: `<inklist><gesture>x,y;x,y;…</gesture>…</inklist>` and `width` (border width).
  - `text` (the SDK's `note`): `icon` when set.
  - `square`, `circle`, `freetext`, `line`, `stamp`, `fileattachment`: the common
    attributes; `line` also `start` and `end` (from `/L`); `freetext` also `<defaultappearance>`
    when `/DA` is set. File contents of `fileattachment` are not exported.
  - Subtypes the SDK models as `unknown` are not exported.
- Numbers are written with up to 4 decimals, no exponent; text is XML-escaped; output is
  UTF-8 with `\n` line ends, so two platforms produce identical text for the same document.

## Import: what is applied

1. Parse the whole document; reject malformed input (see Errors). Limit: 10 MiB of XML.
2. **Fields:** for each `<field>` (joining nested names with `.`), find the field by full name.
   Every widget with that name is set. Text → set text; check box → checked when the value
   equals its export value (or `Yes`/`On` when it has none), unchecked for `Off`; radio
   group → the widget whose export value equals the value is checked and the others are
   unchecked, and no match is `invalidValue` (`Off` unchecks all); combo/list → select the
   options whose text matches. *(Designer's call.)* Unknown name → `unknownField`; read-only → `readOnlyField`; a value that
   fits no option → `invalidValue`.
3. **Annotations** the SDK can create today: `ink` (with color and width), `text` (note,
   with contents and color), `highlight`, `underline`, `strikeout` (from `coords`, with
   color). After creating one, set `/T`, `/NM`, `/M`, `/CreationDate` and `/Contents` from the
   attributes when present, so a round trip keeps author and dates.
   Everything else (`square`, `circle`, `line`, `freetext`, `stamp`, `squiggly`, `polygon`,
   `polyline`, `caret`, `sound`, `fileattachment`, `redact`, …) → `unsupportedType`.
   A `page` outside the document → `pageOutOfRange`; a missing required attribute
   (`page`, `rect`, `coords` for markup, a gesture for ink) → `missingAttribute`.
4. Import changes the document in memory like the existing edit APIs; it is saved with a
   full save as for every created annotation.

## Shared conformance case

`conformance/xfdf/`:
- `source.pdf`: a document with a few form fields (text, check box, combo, a radio group
  of three, and a text field with a widget on two pages) and one
  annotation of each exportable type. Built by a script from existing fixtures where
  possible; annotation types the SDK cannot create are added by the script with raw PDF
  objects.
- `expected-export.xfdf`: the exact text every platform's `exportXfdf` must produce for
  `source.pdf`. Hand-checked, not generated by any SDK.
- `import.xfdf`: field values plus one element of each supported and several unsupported
  types, a nested field name, an unknown field, an out-of-range page and escaped text.
- `expected-import.json`: the expected report after importing `import.xfdf` into
  `source-blank.pdf` (the same document with empty fields and no annotations), plus
  `expected-after-import.xfdf`: what `exportXfdf` must return after that import. Checking
  through export keeps author, dates and colour out of the public API. *(Designer's call.)*
- A malformed file and a file with a `<!DOCTYPE` that declares an external entity, both of
  which must fail with `invalidOperation` and change nothing.

## Platform notes

- XML parsing: Web/Node — a small parser written for this (XFDF needs elements,
  attributes, text and the five predefined entities; anything with `<!DOCTYPE` or other
  entities is rejected), because Node has no `DOMParser`; iOS — `XMLParser` with external
  entities off; Android — `XmlPullParser` from the platform; Java — `DocumentBuilder` with
  DTDs disallowed (`disallow-doctype-decl`) and secure processing on.
- Reading `/T`, `/NM`, `/M`, `/CreationDate`, `/CA`, `/L`, `/DA` and the border width needs
  small additions in each engine layer (PDFium: `FPDFAnnot_GetStringValue`,
  `FPDFAnnot_GetNumberValue`, `FPDFAnnot_GetLine`, `FPDFAnnot_GetBorder`); writing `/T`,
  `/NM`, `/M`, `/CreationDate` uses `FPDFAnnot_SetStringValue`. These stay **internal** to
  XFDF on every platform; the public annotation and form models do not change.
  *(Designer's call.)*
- Java needs more of these internal helpers than the others: its public `PdfAnnotation`
  has no colour, flags, quads or ink strokes, its `PdfFormField` has no export value or
  options, and it has no option setter. All of that is added inside the Java SDK, not to its
  public types. Expect the Java part to be the largest.

## Left to the builder

- File layout per platform, internal helper names, and how the engine additions are shaped.
- The exact contents of the fixtures, within the rules above.
- Order of platforms; Web first is suggested because the conformance fixtures are easiest
  to iterate there.
