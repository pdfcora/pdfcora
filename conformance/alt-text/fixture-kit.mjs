/**
 * Pieces shared by the hand-written PDF/UA test documents: the embedded Liberation Sans font
 * (SIL Open Font License, LICENSE_LIBERATION), uncompressed-RGB images and the file writer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));

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
// WinAnsiEncoding codes 128-159 that are not Latin-1; the rest map to themselves.
const WIN_ANSI = { 128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021,
  136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018, 146: 0x2019,
  147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161,
  155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178 };
const widthsTo = (lastChar) => {
  const widths = [];
  for (let code = 32; code <= lastChar; code++) widths.push(advance(glyphOf(WIN_ANSI[code] ?? code)));
  return widths;
};


export const escape = (text) => text.replace(/[\\()]/g, (c) => `\\${c}`);

export const stream = (header, body) => ({ header, body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1') });

/** Adds the font file, descriptor and font; returns the font's object number. */
/** `lastChar` 255 covers WinAnsi's bullet and dashes; the default keeps older fixtures byte-identical. */
export function addFont(add, lastChar = 126) {
  const fontFile = add(stream(`<< /Length ${ttf.length} /Length1 ${ttf.length} >>`, ttf));
  const descriptor = add(`<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 ` +
    `/FontBBox [${bbox.join(' ')}] /ItalicAngle 0 /Ascent ${ascent} /Descent ${descent} ` +
    `/CapHeight 729 /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
  return add(`<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 ` +
    `/LastChar ${lastChar} /Widths [${widthsTo(lastChar).join(' ')}] /Encoding /WinAnsiEncoding /FontDescriptor ${descriptor} 0 R >>`);
}

export function image(width, height, pixel) {
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

/** The file: header, objects (strings or streams), a classic cross-reference table. */
export function writePdf(objects, trailer) {
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
  tail += `trailer\n<< /Size ${objects.length + 1} ${trailer} >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}
