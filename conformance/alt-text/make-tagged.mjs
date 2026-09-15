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
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const TITLE = 'Annual report 2026';

// --- the font -------------------------------------------------------------------------

const ttf = readFileSync(join(HERE, 'LiberationSans-Regular.ttf'));
const tables = {};
for (let i = 0; i < ttf.readUInt16BE(4); i++) {
  const at = 12 + i * 16;
  tables[ttf.toString('latin1', at, at + 4)] = ttf.readUInt32BE(at + 8);
}
const unitsPerEm = ttf.readUInt16BE(tables.head + 18);
const scale = (v) => Math.round((v * 1000) / unitsPerEm);
const bbox = [36, 38, 40, 42].map((o) => scale(ttf.readInt16BE(tables.head + o)));
const ascent = scale(ttf.readInt16BE(tables.hhea + 4));
const descent = scale(ttf.readInt16BE(tables.hhea + 6));
const metrics = ttf.readUInt16BE(tables.hhea + 34);

function glyphOf(code) {
  const count = ttf.readUInt16BE(tables.cmap + 2);
  for (let i = 0; i < count; i++) {
    const at = tables.cmap + 4 + i * 8;
    if (ttf.readUInt16BE(at) !== 3 || ttf.readUInt16BE(at + 2) !== 1) continue;
    const sub = tables.cmap + ttf.readUInt32BE(at + 4);
    const segments = ttf.readUInt16BE(sub + 6) / 2;
    const ends = sub + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const offsets = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      if (code > ttf.readUInt16BE(ends + s * 2)) continue;
      const start = ttf.readUInt16BE(starts + s * 2);
      if (code < start) return 0;
      const rangeOffset = ttf.readUInt16BE(offsets + s * 2);
      const delta = ttf.readInt16BE(deltas + s * 2);
      if (rangeOffset === 0) return (code + delta) & 0xffff;
      const glyph = ttf.readUInt16BE(offsets + s * 2 + rangeOffset + (code - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
  }
  return 0;
}
const advance = (glyph) => scale(ttf.readUInt16BE(tables.hmtx + Math.min(glyph, metrics - 1) * 4));
const widths = [];
for (let code = 32; code <= 126; code++) widths.push(advance(glyphOf(code)));

// --- images ---------------------------------------------------------------------------

function image(width, height, pixel) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 3);
  }
  const body = deflateSync(data);
  return {
    header: `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${body.length} >>`,
    body,
  };
}

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

const escape = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);
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
const stream = (header, body) => ({ header, body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1') });

const catalog = add(null);
const pagesId = add(null);
const treeRoot = add(null);
const documentElement = add(null);
const fontFile = add(stream(`<< /Length ${ttf.length} /Length1 ${ttf.length} >>`, ttf));
const descriptor = add(`<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 ` +
  `/FontBBox [${bbox.join(' ')}] /ItalicAngle 0 /Ascent ${ascent} /Descent ${descent} ` +
  `/CapHeight 729 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
const font = add(`<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 ` +
  `/LastChar 126 /Widths [${widths.join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptor} 0 R >>`);

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

const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
let length = parts[0].length;
const offsets = objects.map((body, i) => {
  const at = length;
  const chunk = typeof body === 'string'
    ? [Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')]
    : [Buffer.from(`${i + 1} 0 obj\n${body.header}\nstream\n`, 'latin1'), body.body,
      Buffer.from('\nendstream\nendobj\n', 'latin1')];
  for (const c of chunk) { parts.push(c); length += c.length; }
  return at;
});
let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
tail += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
tail += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`;
parts.push(Buffer.from(tail, 'latin1'));

const pdf = Buffer.concat(parts);
writeFileSync(join(HERE, 'tagged.pdf'), pdf);
writeFileSync(join(HERE, 'tagged-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote tagged.pdf (${pdf.length} bytes)`);
