/**
 * Writes conformance/redaction/pii.pdf and pii-expected.json: the document redaction
 * suggestions are tested on. Written by hand, like make-contract.mjs, so the fixture cannot
 * inherit a bug from the SDK. Page 0 is English, page 1 German.
 *
 * Usage: node conformance/redaction/make-pii.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGES = [
  [
    'Customer record',
    'Name: Anna Schmidt, born on 14 March 1985.',
    'Address: 221B Baker Street, London NW1 6XE, United Kingdom.',
    'Email anna.schmidt@example.com or call +44 20 7946 0958 or 020 7946 0958.',
    'US office: (212) 555-0142, fax 212-555-0199.',
    'IBAN GB29 NWBK 6016 1331 9268 19. Old IBAN GB29 NWBK 6016 1331 9268 18.',
    'Card 4111 1111 1111 1111 is valid; 4111 1111 1111 1112 is not.',
    'Passport number 502135326 was issued on 2019-04-02.',
    'Portal https://portal.example.com/account and www.example.org.',
    'Server 192.168.10.25 and 2001:db8::8a2e:370:7334.',
    'Anna Schmidt signed on September 15, 2026.',
  ],
  [
    'Kundendaten',
    'Name: Jonas Müller, geboren am 3. März 1990.',
    'Anschrift: Hauptstraße 12, 10115 Berlin.',
    'E-Mail jonas.mueller@beispiel.de, Telefon 030 12345678, mobil 0171 1234567.',
    'Fax 030/1234567, international +49 30 12345678.',
    'IBAN DE89 3704 0044 0532 0130 00, falsche IBAN DE89 3704 0044 0532 0130 01.',
    'Kreditkarte 5500-0000-0000-0004.',
    'Personalausweis L01X00T47, Steuer-ID 65929970489.',
    'Termin am 15.09.2026, Rückruf am 16.9.26, Frist 31.02.2026 ungültig.',
    'Jonas Müller unterschreibt am 15. Sept. 2026.',
  ],
];

const EXPECTED = [
  [0, 'date', '14 March 1985'], [0, 'email', 'anna.schmidt@example.com'],
  [0, 'phone', '+44 20 7946 0958'], [0, 'phone', '020 7946 0958'],
  [0, 'phone', '(212) 555-0142'], [0, 'phone', '212-555-0199'],
  [0, 'iban', 'GB29 NWBK 6016 1331 9268 19'], [0, 'paymentCard', '4111 1111 1111 1111'],
  [0, 'date', '2019-04-02'], [0, 'url', 'https://portal.example.com/account'],
  [0, 'url', 'www.example.org'], [0, 'ipAddress', '192.168.10.25'],
  [0, 'ipAddress', '2001:db8::8a2e:370:7334'], [0, 'date', 'September 15, 2026'],
  [1, 'date', '3. März 1990'], [1, 'email', 'jonas.mueller@beispiel.de'],
  [1, 'phone', '030 12345678'], [1, 'phone', '0171 1234567'],
  [1, 'phone', '030/1234567'], [1, 'phone', '+49 30 12345678'],
  [1, 'iban', 'DE89 3704 0044 0532 0130 00'], [1, 'paymentCard', '5500-0000-0000-0004'],
  [1, 'date', '15.09.2026'], [1, 'date', '16.9.26'], [1, 'date', '15. Sept. 2026'],
].map(([pageIndex, category, text]) => ({ pageIndex, category, text }));

function contentStream(lines) {
  return ['BT', '/F1 11 Tf', '15 TL', '72 740 Td',
    ...lines.map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`), 'ET'].join('\n');
}

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };
const catalog = add(null);
const pagesId = add(null);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const pageIds = PAGES.map((lines) => {
  const stream = contentStream(lines);
  const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
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

writeFileSync(join(HERE, 'pii.pdf'), pdf, 'latin1');
writeFileSync(join(HERE, 'pii-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote pii.pdf (${pdf.length} bytes) and ${EXPECTED.length} expected suggestions`);
