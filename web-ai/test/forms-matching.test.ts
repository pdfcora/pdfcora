import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfiumkit/web';
import { matchField } from '../dist/forms/synonyms.js';
import { describeFields } from '../dist/forms/describe.js';

const DIR = new URL('../../conformance/forms/', import.meta.url);
const CASES = JSON.parse(readFileSync(new URL('matching.json', DIR), 'utf8'));

for (const c of CASES) {
  test(`matching: ${c.name} / ${c.alternateName ?? '-'} / ${c.label ?? '-'}`, () => {
    assert.equal(matchField({ name: c.name ?? undefined, alternateName: c.alternateName ?? undefined, label: c.label ?? undefined }) ?? 'unknown', c.expected);
  });
}

test('fields are described with the page text next to them', async () => {
  const document = await PdfDocument.open(new Uint8Array(readFileSync(new URL('forms.pdf', DIR))));
  const labels = Object.fromEntries((await describeFields(document)).map((f) => [f.name, f.label ?? null]));
  assert.deepEqual(labels, {
    fname: 'First name', Surname_1: 'Surname', Text3: 'Date of birth (MM/DD/YYYY)', email: 'Email', Text5: 'Phone',
    Text6: 'Street address', Zip: 'ZIP code', Town: 'City', Country: 'Country', Text9: 'IBAN', Text11: 'Employer',
    Newsletter: 'Send me the newsletter', Colour: 'Favourite colour', Signature1: 'Signature', Submit: null,
    Vorname: 'Vorname', Feld2: 'Nachname', Geb: 'Geburtsdatum (TT.MM.JJJJ)', Feld4: 'E-Mail-Adresse', Feld5: 'Telefonnummer',
    Feld6: 'Straße und Hausnummer', Plz: 'PLZ', Wohnort: 'Ort', Land: 'Land', Feld9: 'IBAN', Zustimmung: 'Ich stimme zu', Feld11: 'Firma',
  });
});
