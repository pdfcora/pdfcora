/**
 * Writes conformance/alt-text/tagged.pdf and tagged-expected.json: a tagged PDF whose only
 * PDF/UA-1 failures are figures without alternate text. Written by hand, like
 * make-contract.mjs, so the fixture cannot inherit a bug from the SDK.
 *
 * Liberation Sans is embedded (SIL Open Font License, LICENSE_LIBERATION) because PDF/UA
 * requires embedded fonts.
 *
 * Usage: node conformance/alt-text/make-tagged.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addFont, escape, image, stream, writePdf } from './fixture-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TITLE = 'Annual report 2026';

// --- images ---------------------------------------------------------------------------

const photo = image(180, 120, (x, y) => {
  const sun = (x - 130) ** 2 + (y - 35) ** 2 < 18 ** 2;
  if (sun) return [250, 200, 60];
  if (y > 80 && x > 20 && x < 110) return [70, 70, 90];           // the building
  return [40 + y, 60 + y, 140 + Math.floor(y / 2)];
});
const rule = image(468, 2, () => [150, 150, 150]);
const logo = image(96, 96, (x, y) =>
  ((x - 48) ** 2 + (y - 48) ** 2 < 40 ** 2 ? [200, 30, 40] : [255, 255, 255]));

// --- pages ----------------------------------------------------------------------------

const text = (tag, mcid, size, x, y, value) =>
  `/${tag} <</MCID ${mcid}>> BDC BT /F1 ${size} Tf ${x} ${y} Td (${escape(value)}) Tj ET EMC`;
const drawn = (mcid, name, w, h, x, y) =>
  `/Figure <</MCID ${mcid}>> BDC q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q EMC`;

// Each page: its content and, per MCID, the structure element type and extras.
const PAGES = [
  {
    content: [
      text('H1', 0, 20, 72, 720, TITLE),
      text('P', 1, 11, 72, 690, 'Revenue grew in every region this year.'),
      '/Figure <</MCID 2>> BDC 0.2 0.4 0.8 rg 90 520 30 100 re f 140 520 30 140 re f 190 520 30 70 re f EMC',
      text('P', 3, 11, 72, 500, 'Figure 1: Revenue by region.'),
      drawn(4, 'Im1', 216, 144, 72, 300),
      text('P', 5, 11, 72, 284, 'Figure 2: The new office building in Berlin at dusk.'),
      drawn(6, 'Im2', 468, 2, 72, 260),
      text('P', 7, 11, 72, 230, 'Staff numbers rose to 120 people.'),
    ],
    elements: [['H1'], ['P'], ['Figure', { alt: 'Bar chart of revenue by region' }], ['P'],
      ['Figure'], ['P'], ['Figure'], ['P']],
    images: { Im1: photo, Im2: rule },
  },
  {
    content: [
      text('H2', 0, 16, 72, 720, 'Outlook'),
      text('P', 1, 11, 72, 690, 'Next year the company plans two more offices.'),
      drawn(2, 'Im3', 96, 96, 72, 560),
      text('P', 3, 11, 72, 540, 'Figure 3: The company logo.'),
    ],
    // The figure's content is referenced through a marked-content reference dictionary.
    elements: [['H2'], ['P'], ['Figure', { mcr: true }], ['P']],
    images: { Im3: logo },
  },
];

const EXPECTED = {
  figuresWithoutAlt: [
    { pageIndex: 0, markedContentIds: [4], kind: 'description', caption: 'Figure 2: The new office building in Berlin at dusk.' },
    { pageIndex: 0, markedContentIds: [6], kind: 'decorative' },
    { pageIndex: 1, markedContentIds: [2], kind: 'description', caption: 'Figure 3: The company logo.' },
  ],
  figuresWithAlt: [{ pageIndex: 0, markedContentIds: [2], altText: 'Bar chart of revenue by region' }],
};

// --- objects --------------------------------------------------------------------------

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };

const catalog = add(null);
const pagesId = add(null);
const treeRoot = add(null);
const documentElement = add(null);
const font = addFont(add);

const xmp = `<?xpacket begin="ï»¿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${TITLE}</rdf:li></rdf:Alt></dc:title>
<pdfuaid:part>1</pdfuaid:part>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
const metadata = add(stream(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp, 'latin1')} >>`, xmp));
const info = add(`<< /Title (${TITLE}) >>`);

const kids = [];
const parentTreeNums = [];
const pageIds = PAGES.map((page, pageIndex) => {
  const pageId = add(null);
  const xobjects = Object.entries(page.images)
    .map(([name, img]) => `/${name} ${add(stream(img.header, img.body))} 0 R`).join(' ');
  const body = page.content.join('\n');
  const content = add(stream(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>`, body));

  const parents = page.elements.map(([type, extra = {}], mcid) => {
    const k = extra.mcr ? `<< /Type /MCR /Pg ${pageId} 0 R /MCID ${mcid} >>` : `${mcid}`;
    const pg = extra.mcr ? '' : ` /Pg ${pageId} 0 R`;
    const alt = extra.alt ? ` /Alt (${escape(extra.alt)})` : '';
    const id = add(`<< /Type /StructElem /S /${type} /P ${documentElement} 0 R${pg} /K ${k}${alt} >>`);
    kids.push(id);
    return id;
  });
  parentTreeNums.push(`${pageIndex} ${add(`[${parents.map((id) => `${id} 0 R`).join(' ')}]`)} 0 R`);

  objects[pageId - 1] = `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> /XObject << ${xobjects} >> >> ` +
    `/Contents ${content} 0 R /StructParents ${pageIndex} /Tabs /S >>`;
  return pageId;
});

const parentTree = add(`<< /Nums [${parentTreeNums.join(' ')}] >>`);
objects[documentElement - 1] = `<< /Type /StructElem /S /Document /P ${treeRoot} 0 R ` +
  `/K [${kids.map((id) => `${id} 0 R`).join(' ')}] >>`;
objects[treeRoot - 1] = `<< /Type /StructTreeRoot /K ${documentElement} 0 R ` +
  `/ParentTree ${parentTree} 0 R /ParentTreeNextKey ${PAGES.length} >>`;
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /StructTreeRoot ${treeRoot} 0 R ` +
  `/MarkInfo << /Marked true >> /Lang (en-GB) /Metadata ${metadata} 0 R ` +
  `/ViewerPreferences << /DisplayDocTitle true >> >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

const pdf = writePdf(objects, `/Root ${catalog} 0 R /Info ${info} 0 R`);
writeFileSync(join(HERE, 'tagged.pdf'), pdf);
writeFileSync(join(HERE, 'tagged-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote tagged.pdf (${pdf.length} bytes)`);
