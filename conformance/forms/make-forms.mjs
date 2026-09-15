/**
 * Writes conformance/forms/forms.pdf and forms-expected.json: the forms smart form filling
 * is tested on. Written by hand, like make-contract.mjs, so the fixture cannot inherit a bug
 * from the SDK. Page 0 is an English form, page 1 a German one; each label is page text to
 * the left of its field.
 *
 * Usage: node conformance/forms/make-forms.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

// [label, labelX, field] rows; a field is { name, kind, rect: [l, r], tooltip?, options? }.
// Rows share a y; two fields on one row test the label boundary.
const PAGES = [
  [
    [['First name', 72, { name: 'fname', kind: 'text', x: [260, 500] }]],
    [['Surname', 72, { name: 'Surname_1', kind: 'text', x: [260, 500] }]],
    [['Date of birth (MM/DD/YYYY)', 72, { name: 'Text3', kind: 'text', x: [260, 500] }]],
    [['Email', 72, { name: 'email', kind: 'text', x: [260, 500], tooltip: 'E-mail address' }]],
    [['Phone', 72, { name: 'Text5', kind: 'text', x: [260, 500] }]],
    [['Street address', 72, { name: 'Text6', kind: 'text', x: [260, 500] }]],
    [['ZIP code', 72, { name: 'Zip', kind: 'text', x: [130, 230] }], ['City', 250, { name: 'Town', kind: 'text', x: [285, 500] }]],
    [['Country', 72, { name: 'Country', kind: 'combo', x: [260, 500], options: ['Germany', 'United Kingdom', 'United States'] }]],
    [['IBAN', 72, { name: 'Text9', kind: 'text', x: [260, 500] }]],
    [['Employer', 72, { name: 'Text11', kind: 'text', x: [260, 500] }]],
    [['Send me the newsletter', 72, { name: 'Newsletter', kind: 'check', x: [260, 276] }]],
    [['Favourite colour', 72, { name: 'Colour', kind: 'text', x: [260, 500] }]],
    [['Signature', 72, { name: 'Signature1', kind: 'sig', x: [260, 500] }]],
    [['', 72, { name: 'Submit', kind: 'push', x: [260, 340] }]],
  ],
  [
    [['Vorname', 72, { name: 'Vorname', kind: 'text', x: [260, 500] }]],
    [['Nachname', 72, { name: 'Feld2', kind: 'text', x: [260, 500] }]],
    [['Geburtsdatum (TT.MM.JJJJ)', 72, { name: 'Geb', kind: 'text', x: [260, 500] }]],
    [['E-Mail-Adresse', 72, { name: 'Feld4', kind: 'text', x: [260, 500] }]],
    [['Telefonnummer', 72, { name: 'Feld5', kind: 'text', x: [260, 500] }]],
    [['Straße und Hausnummer', 72, { name: 'Feld6', kind: 'text', x: [260, 500] }]],
    [['PLZ', 72, { name: 'Plz', kind: 'text', x: [100, 200] }], ['Ort', 250, { name: 'Wohnort', kind: 'text', x: [285, 500] }]],
    [['Land', 72, { name: 'Land', kind: 'combo', x: [260, 500], options: ['Deutschland', 'Österreich', 'Schweiz'] }]],
    [['IBAN', 72, { name: 'Feld9', kind: 'text', x: [260, 500] }]],
    [['Ich stimme zu', 72, { name: 'Zustimmung', kind: 'check', x: [260, 276] }]],
    [['Firma', 72, { name: 'Feld11', kind: 'text', x: [260, 500] }]],
  ],
];

const EXPECTED = [
  [0, 'fname', 'givenName', 'Anna'], [0, 'Surname_1', 'familyName', 'Schmidt'],
  [0, 'Text3', 'dateOfBirth', '03/14/1985'], [0, 'email', 'email', 'anna.schmidt@example.com'],
  [0, 'Text5', 'phone', '+44 20 7946 0958'], [0, 'Text6', 'street', '221B Baker Street'],
  [0, 'Zip', 'postalCode', 'NW1 6XE'], [0, 'Town', 'city', 'London'],
  [0, 'Country', 'country', 1], [0, 'Text9', 'iban', 'GB29 NWBK 6016 1331 9268 19'],
  [0, 'Text11', 'company', 'Example Holdings Ltd'],
  [1, 'Vorname', 'givenName', 'Anna'], [1, 'Feld2', 'familyName', 'Schmidt'],
  [1, 'Geb', 'dateOfBirth', '14.03.1985'], [1, 'Feld4', 'email', 'anna.schmidt@example.com'],
  [1, 'Feld5', 'phone', '+44 20 7946 0958'], [1, 'Feld6', 'street', '221B Baker Street'],
  [1, 'Plz', 'postalCode', 'NW1 6XE'], [1, 'Wohnort', 'city', 'London'],
  [1, 'Feld9', 'iban', 'GB29 NWBK 6016 1331 9268 19'], [1, 'Feld11', 'company', 'Example Holdings Ltd'],
].map(([pageIndex, fieldName, key, value]) => ({ pageIndex, fieldName, key, value }));

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };
const catalog = add(null);
const pagesId = add(null);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const checkOn = add('<< /Length 0 /Type /XObject /Subtype /Form /BBox [0 0 16 16] >>\nstream\n\nendstream');
const checkOff = add('<< /Length 0 /Type /XObject /Subtype /Form /BBox [0 0 16 16] >>\nstream\n\nendstream');
const fields = [];

const pageIds = PAGES.map((rows) => {
  const pageId = add(null);
  const lines = [];
  const annots = [];
  rows.forEach((row, i) => {
    const y = 720 - i * 34;
    for (const [label, labelX, field] of row) {
      if (label) lines.push(`BT /F1 11 Tf ${labelX} ${y + 4} Td (${esc(label)}) Tj ET`);
      const rect = `[${field.x[0]} ${y} ${field.x[1]} ${y + 16}]`;
      const common = `/Type /Annot /Subtype /Widget /T (${esc(field.name)}) /Rect ${rect} /P ${pageId} 0 R /F 4 /DA (/Helv 10 Tf 0 g)` +
        (field.tooltip ? ` /TU (${esc(field.tooltip)})` : '');
      const body = {
        text: `<< ${common} /FT /Tx /V () >>`,
        combo: `<< ${common} /FT /Ch /Ff 131072 /Opt [${(field.options ?? []).map((o) => `(${esc(o)})`).join(' ')}] /V () >>`,
        check: `<< ${common} /FT /Btn /V /Off /AS /Off /AP << /N << /Yes ${checkOn} 0 R /Off ${checkOff} 0 R >> >> >>`,
        push: `<< ${common} /FT /Btn /Ff 65536 >>`,
        sig: `<< ${common} /FT /Sig >>`,
      }[field.kind];
      const id = add(body);
      annots.push(id);
      fields.push(id);
    }
  });
  const stream = lines.join('\n');
  const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}] >>`;
  return pageId;
});

const acroForm = add(`<< /Fields [${fields.map((f) => `${f} 0 R`).join(' ')}] /DA (/Helv 10 Tf 0 g) ` +
  `/DR << /Font << /Helv ${font} 0 R >> >> /NeedAppearances true >>`);
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm ${acroForm} 0 R >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

let pdf = '%PDF-1.7\n';
const offsets = objects.map((body, i) => {
  const at = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

writeFileSync(join(HERE, 'forms.pdf'), pdf, 'latin1');
writeFileSync(join(HERE, 'forms-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote forms.pdf (${pdf.length} bytes, ${fields.length} fields) and ${EXPECTED.length} expected proposals`);
