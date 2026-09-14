/**
 * Writes conformance/fixtures/contract.pdf, the document grounded answers are tested on.
 *
 * Written by hand rather than with any SDK, so the fixture cannot inherit a bug from the
 * code it tests. Three pages: clauses, the clause the acceptance test asks about, and a
 * scanned-looking page with no text layer at all.
 *
 * Usage: node conformance/make-contract.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PAGES = [
  [
    '1. Parties',
    'This agreement is made between Example Holdings Ltd and the Supplier.',
    'The Supplier provides maintenance services for the equipment listed in Annex A.',
    '2. Term',
    'The agreement starts on 1 March 2026 and runs for an initial term of two years.',
    'Either party may renew the agreement in writing before the term ends.',
  ],
  [
    '12. Termination',
    '12.1 The notice period is three months, ending on the last day of a calendar month.',
    '12.2 Notice must be given in writing to the registered address of the other party.',
    '13. Payment',
    'Invoices are payable within thirty days of receipt.',
    'Late payments carry interest at four percent above the base rate.',
  ],
  [],
];

function contentStream(lines) {
  if (lines.length === 0) return '0 0 1 rg 72 600 200 100 re f';
  return ['BT', '/F1 11 Tf', '14 TL', '72 720 Td',
    ...lines.map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`), 'ET'].join('\n');
}

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };

const catalog = add(null);
const pagesId = add(null);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const pageIds = PAGES.map((lines) => {
  const stream = contentStream(lines);
  const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

let pdf = '%PDF-1.7\n';
const offsets = objects.map((body, i) => {
  const at = pdf.length;
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(HERE, 'fixtures', 'contract.pdf'), pdf, 'latin1');
  console.log(`wrote conformance/fixtures/contract.pdf (${pdf.length} bytes, ${PAGES.length} pages)`);
}
