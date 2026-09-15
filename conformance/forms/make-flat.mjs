/**
 * Writes conformance/forms/flat.pdf: a printed form with blanks but no form fields, for flat
 * form detection (FORM-7). Written by hand, like the other fixtures. flat-expected.json is
 * maintained by hand from the drawing below (rectangles within 1 pt).
 *
 * Usage: node conformance/forms/make-flat.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = (x, y, s) => `BT /F1 11 Tf ${x} ${y} Td (${s.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;

const content = [
  text(72, 700, 'First name: ______________________________'),   // underscores
  text(72, 664, 'Last name'), '0.5 w 180 662 m 500 662 l S',          // a line
  text(72, 628, 'Email'), '0.5 w 180 622 320 20 re S',                // a box
  text(72, 592, 'City'), '0.5 w 180 586 320 20 re S', '0.5 w 186 589 m 494 589 l S', // a box around an underline
  '0.5 w 72 548 12 12 re S', text(90, 550, 'Send me the newsletter'),  // checkboxes, label to the right
  '0.5 w 72 518 12 12 re S', text(90, 520, 'I agree to the terms'),
  '0.5 w 72 470 228 30 re S', text(80, 482, 'Office use only'),       // a box that holds text
].join('\n');

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
  `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
];
let pdf = '%PDF-1.7\n';
const offsets = objects.map((body, i) => {
  const at = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(join(HERE, 'flat.pdf'), pdf, 'latin1');
console.log(`wrote flat.pdf (${pdf.length} bytes)`);
