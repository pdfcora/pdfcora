/**
 * Writes conformance/remediation/untagged.pdf and untagged-expected.json: an untagged PDF
 * whose content remediation should tag as headings, paragraphs, list items, a figure and an
 * artifact. The font is embedded, so once tagged (and the figure described) the document can
 * pass PDF/UA-1. Written by hand, so the fixture cannot inherit a bug from the SDK.
 *
 * Usage: node conformance/remediation/make-untagged.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFont, escape, image, stream, writePdf } from '../alt-text/fixture-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const photo = image(180, 120, (x, y) => {
  if ((x - 130) ** 2 + (y - 35) ** 2 < 18 ** 2) return [250, 200, 60];
  if (y > 80 && x > 20 && x < 110) return [70, 70, 90];
  return [40 + y, 60 + y, 140 + Math.floor(y / 2)];
});
const rule = image(468, 2, () => [150, 150, 150]);

// One entry per drawing: [expected type, content]. Text is WinAnsi ("\x95" is a bullet).
const text = (size, x, y, value) => `BT /F1 ${size} Tf ${x} ${y} Td (${escape(value)}) Tj ET`;
const drawn = (name, w, h, x, y) => `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q`;

const PAGES = [
  {
    images: { Im1: photo, Im2: rule },
    blocks: [
      ['H1', [text(20, 72, 720, 'Quarterly newsletter')]],
      ['P', [text(11, 72, 690, 'Welcome to the autumn issue. This quarter we opened'),
        text(11, 72, 676, 'two offices and welcomed forty new colleagues.')]],
      ['H2', [text(16, 72, 640, 'Highlights')]],
      ['LI', [text(11, 72, 615, '\x95 A new office in Berlin')]],
      ['LI', [text(11, 72, 600, '\x95 A new office in Madrid')]],
      ['LI', [text(11, 72, 585, '\x95 The staff survey results')]],
      ['P', [text(11, 72, 555, 'The photo below shows the Berlin office.')]],
      ['Figure', [drawn('Im1', 216, 144, 72, 390)]],
      ['P', [text(11, 72, 374, 'Figure 1: The Berlin office at dusk.')]],
      ['Artifact', [drawn('Im2', 468, 2, 72, 360)]],
    ],
  },
  {
    images: {},
    blocks: [
      ['H2', [text(16, 72, 720, 'Next steps')]],
      ['LI', [text(11, 72, 695, '1. Open the Madrid office in spring.')]],
      ['LI', [text(11, 72, 680, '2. Repeat the survey next year.')]],
      ['P', [text(11, 72, 650, 'Thank you for reading.')]],
    ],
  },
];

const EXPECTED = PAGES.flatMap((page, pageIndex) => page.blocks.map(([type, parts]) => ({
  pageIndex,
  type,
  objectCount: parts.length,
  text: parts.map((p) => /\((.*)\) Tj/.exec(p)?.[1] ?? '').join(' ').replace(/\\(.)/g, '$1')
    .replace(/\x95/g, '•'),
})));

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };
const catalog = add(null);
const pagesId = add(null);
const font = addFont(add, 255);

const pageIds = PAGES.map((page) => {
  const pageId = add(null);
  const xobjects = Object.entries(page.images)
    .map(([name, img]) => `/${name} ${add(stream(img.header, img.body))} 0 R`).join(' ');
  const body = page.blocks.flatMap(([, parts]) => parts).join('\n');
  const content = add(stream(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>`, body));
  objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> /XObject << ${xobjects} >> >> /Contents ${content} 0 R >>`;
  return pageId;
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

const pdf = writePdf(objects, `/Root ${catalog} 0 R`);
writeFileSync(join(HERE, 'untagged.pdf'), pdf);
writeFileSync(join(HERE, 'untagged-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote untagged.pdf (${pdf.length} bytes), ${EXPECTED.length} blocks`);
