/**
 * Writes conformance/remediation/heading-order.pdf and heading-order-expected.json: an
 * untagged document whose largest heading is *not* the first one. Tagging by font size
 * alone would make the first heading an H2 and skip a level, which PDF/UA 7.4.2 forbids;
 * the proposals must start at H1 and step down one level at a time. Found by surveying
 * real documents, where a late oversized line is common.
 *
 * Usage: node conformance/remediation/make-heading-order.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFont, escape, stream, writePdf } from '../alt-text/fixture-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const text = (size, x, y, value) => `BT /F1 ${size} Tf ${x} ${y} Td (${escape(value)}) Tj ET`;

// [expected type, size, text]. 11pt is the body size; 14, 16 and 30 are headings, and the
// largest comes last, which is what makes the fixture interesting.
const LINES = [
  ['H1', 16, 'Department report'],
  ['P', 11, 'This report covers the summer quarter and its three projects.'],
  ['H2', 14, 'Projects'],
  ['P', 11, 'Each project is listed with its owner and its budget.'],
  ['H1', 30, 'Total spend'],
  ['P', 11, 'The total is within the budget agreed in March.'],
];

let y = 720;
const body = LINES.map(([, size, value]) => {
  const line = text(size, 72, y, value);
  y -= size + 14;
  return line;
}).join('\n');

const EXPECTED = LINES.map(([type, , value]) => ({ pageIndex: 0, type, objectCount: 1, text: value }));

const objects = [];
const add = (b) => { objects.push(b); return objects.length; };
const catalog = add(null);
const pages = add(null);
const font = addFont(add, 255);
const content = add(stream(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>`, body));
const page = add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] ` +
  `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
objects[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;

const pdf = writePdf(objects, `/Root ${catalog} 0 R`);
writeFileSync(join(HERE, 'heading-order.pdf'), pdf);
writeFileSync(join(HERE, 'heading-order-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote heading-order.pdf (${pdf.length} bytes), ${EXPECTED.length} blocks`);
