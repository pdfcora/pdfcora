# PdfiumKit — Smart Form Filling Design

Date: 2026-09-15
Status: Implemented 2026-09-15
Implements: FORM-1 to FORM-6 and HIL-1 to HIL-3 of `2026-09-13-pdfiumkit-ai-requirements.md`
(AI Phase 2, second half)

## 1. Purpose

Recognise that "Nachname", "Surname_1" and a field labelled "Last name" all ask for the same
thing, propose values from a profile the host passes in, and fill in only what the user
accepts.

Success criteria:

- A shared set of field descriptions matches to the same profile key on iOS, Android and web,
  with no model.
- On the shared English and German test forms, the synonym list alone proposes the expected
  value for every field it should, and nothing for the fields it should not.
- A choice field whose options do not include the profile value gets no proposal.
- No field changes until `apply`; `undo` restores the document.

## 2. Decisions

The owner asked for no confirmation rounds on this feature; these follow the requirements and
the redaction suggestions design.

| Question | Decision |
| --- | --- |
| Languages of the synonym list | English and German (open question 3), as for redaction |
| Profile | Passed in per call as key → string; never stored (FORM-4) |
| Model | The custom provider only, everywhere; the synonym list runs first and wins. Apple's on-device model is not used (§5.2) |
| Review | The redaction review marks, with a label showing each proposed value |
| Undo | Snapshot before apply, as for redaction |
| Measurement | Apple's model through the iOS simulator |

## 3. Profile schema (FORM-2)

`givenName`, `familyName`, `fullName`, `dateOfBirth`, `email`, `phone`, `street`,
`postalCode`, `city`, `country`, `iban`, `company`.

Values are strings. `dateOfBirth` is ISO 8601 (`1985-03-14`). A key missing from the profile
proposes nothing.

## 4. Describing fields (FORM-1)

For each form field on the pages in scope:

| Part | Source |
| --- | --- |
| `name` | the field's partial name, as the core reads it |
| `alternateName` | the tooltip (`/TU`) |
| `label` | page text next to the field (below) |
| `kind` | the core's field kind |
| `options` | choice fields' option labels; toggles' export value |
| `rect` | the field's rectangle |

**Label.** Characters whose box centre lies within the field's vertical extent (±2 pt) and
that end left of the field, within 250 pt, and right of any other field on that line that is
itself left of this one. If none, characters whose box bottom is within 14 pt above the
field's top and that overlap it horizontally. Trailing `:` and whitespace are trimmed.

## 5. Matching

### 5.1 Synonym list (FORM-3)

Runs on every device. Each key has phrases in English and German:

| Key | Phrases |
| --- | --- |
| `givenName` | first name, given name, forename, vorname, rufname |
| `familyName` | last name, surname, family name, nachname, familienname, zuname |
| `fullName` | full name, name, your name, vollständiger name, name und vorname |
| `dateOfBirth` | date of birth, birth date, birthday, dob, geburtsdatum, geboren am |
| `email` | email, e-mail, email address, e-mail address, e-mail-adresse, mail |
| `phone` | phone, telephone, phone number, mobile, telefon, telefonnummer, mobilnummer, handy |
| `street` | street, address, street address, address line 1, straße, strasse, straße und hausnummer, anschrift |
| `postalCode` | postal code, postcode, zip, zip code, plz, postleitzahl |
| `city` | city, town, ort, stadt, wohnort |
| `country` | country, land, staat |
| `iban` | iban, bank account, kontonummer |
| `company` | company, organisation, organization, employer, firma, unternehmen, arbeitgeber |

**Normalising.** Lower-case; `ß` → `ss`; `ä ö ü` → `ae oe ue`; `_`, `-`, `.`, `/` and digits
become spaces; anything that is not a letter or space is removed; spaces collapse. Phrases
are normalised the same way. A trailing format hint in parentheses is removed before
normalising (it is kept for date formatting).

**Rule.** Each of `alternateName`, `label` and `name` is tried in that order; the first that
yields a match decides. A text matches a phrase when the normalised phrase equals the text or
appears in it as whole words. When several phrases match, the one with the most words wins,
then the one with the most letters (so "e mail" beats "address" in "E-mail address", and
"nachname" beats "name"); ties go to the key earlier in §3. No match is `unknown`.

### 5.2 The model

When the synonym list leaves fillable fields `unknown` and a custom provider is configured,
those field descriptions go to it in one prompt, with a JSON schema:
`{ "fields": [{ "id": …, "key": … }] }`. The prompt says to answer `unknown` unless a field's
own text names the detail, and not to assign details by position.

**Apple's on-device model is not used.** Measured on 2026-09-15 on the test form with labels
removed, over four runs, it assigned keys in the order the fields were listed (the German page
came back familyName, fullName, dateOfBirth, email… for Vorname, Feld2, Geb, Feld4…), or echoed
field names as keys. A single such match would propose a date of birth for an IBAN field. A key outside §3 or `unknown`, or an id
not sent, is dropped. The model never overrides a synonym match; that is how the list
double-checks it. `source` is `customProvider` for these, `rules` for synonyms.

### 5.3 Fillable kinds (FORM-6)

`text`, `checkBox`, `radioButton`, `comboBox`, `listBox` are fillable. `pushButton`,
`signature` and `unknown` are described as not fillable and never proposed. A read-only field
is not proposed.

## 6. Formatting (FORM-5)

| Kind | Proposal |
| --- | --- |
| `text` | the profile value; for `dateOfBirth`, formatted by the field's hint: `TT.MM.JJJJ`/`DD.MM.YYYY` → `14.03.1985`, `MM/DD/YYYY` → `03/14/1985`, `DD/MM/YYYY` → `14/03/1985`, otherwise ISO |
| `comboBox`, `listBox` | the option whose label equals the value, compared normalised; none → no proposal |
| `checkBox`, `radioButton` | checked, when the export value equals the value, compared normalised; otherwise no proposal |

A text proposal equal to the field's current value is not proposed.

## 7. API

```ts
const proposals = await ai.forms.propose(profile, { pages? });
proposals.items;      // PdfFormProposal[]: { id, pageIndex, annotationIndex, fieldName, kind, key, value, source, rect }
proposals.modelUsed;
proposals.notice;     // "Check every value before filling in the form."
const applied = await proposals.apply(acceptedIds);   // writes through setText / setChecked / setOption
const restored = await applied.undo();
```

`value` is the text to write, the option index for choices, or `true` for toggles. The id is
`"<pageIndex>:<annotationIndex>:<key>"`. Gated as the `ai` license module for proposing;
writing goes through the core, gated as `forms`.

Review uses the viewer marks, with `PdfMark.label` (new, optional) drawn inside each mark: the
proposed value.

## 8. Testing

- `conformance/forms/matching.json`: field descriptions → expected key, run by every platform.
- `conformance/forms/make-forms.mjs` writes `forms.pdf` (page 0 English, page 1 German) with
  AcroForm widgets and printed labels, and `forms-expected.json` (field name → key and
  proposed value for a fixed profile). Each platform proposes exactly that list with no model.
- A fake provider fills an unknown field, cannot override a synonym match, and a bad key is
  dropped.
- `apply` writes the accepted values and leaves the rest; an unknown id writes nothing; `undo`
  restores the original values.
- Viewer marks draw `label`.
- Apple's model measured on field matching, as the evidence for not using it.

## 9. Out of scope

- Detecting fields on flat PDFs (FORM-7).
- Languages beyond English and German.
- Storing profiles.
