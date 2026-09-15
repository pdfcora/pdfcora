/**
 * Writes conformance/diff/original.pdf, revised.pdf and expected.json: two versions of a short
 * tenancy agreement for the semantic diff. The revision rewords one sentence, changes a number,
 * adds a sentence and removes one. Written by hand, like the other fixtures.
 *
 * Usage: node conformance/diff/make-versions.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const ORIGINAL = [
  ['Tenancy agreement.',
    'This agreement is made between Anna Schmidt and Example Lettings Ltd.',
    'The tenant shall pay the rent monthly in advance.',
    'The rent is 950 pounds per month.',
    'The deposit is held in a government scheme.',
    'Pets are not allowed in the flat.'],
  ['The notice period is 30 days.',
    'Either party may end the agreement in writing.',
    'The landlord repairs the heating system.',
    'This agreement is governed by the law of England.'],
];

const REVISED = [
  ['Tenancy agreement.',
    'This agreement is made between Anna Schmidt and Example Lettings Ltd.',
    'Rent is payable by the tenant every month in advance.',
    'The rent is 950 pounds per month.',
    'The deposit is held in a government scheme.'],
  ['The notice period is 60 days.',
    'Either party may end the agreement in writing.',
    'The tenant may sublet one room with written consent.',
    'The landlord repairs the heating system.',
    'This agreement is governed by the law of England.'],
];

const EXPECTED = [
  { kind: 'modified', original: 'The tenant shall pay the rent monthly in advance.', revised: 'Rent is payable by the tenant every month in advance.' },
  { kind: 'removed', original: 'Pets are not allowed in the flat.' },
  { kind: 'modified', original: 'The notice period is 30 days.', revised: 'The notice period is 60 days.' },
  { kind: 'added', revised: 'The tenant may sublet one room with written consent.' },
];

function pdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const ids = pages.map((lines) => {
    const stream = ['BT', '/F1 12 Tf', '18 TL', '72 720 Td',
      ...lines.map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${ids.length} >>`;
  let out = '%PDF-1.7\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

writeFileSync(join(HERE, 'original.pdf'), pdf(ORIGINAL), 'latin1');
writeFileSync(join(HERE, 'revised.pdf'), pdf(REVISED), 'latin1');
writeFileSync(join(HERE, 'expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote original.pdf, revised.pdf and ${EXPECTED.length} expected changes`);
