/**
 * Writes the shared XFDF case: source.pdf, source-blank.pdf and expected-export.xfdf.
 *
 * Written by hand rather than with any SDK, so the fixture cannot inherit a bug from the
 * code it tests. expected-export.xfdf is derived here from the same data the PDF is
 * written from, following the canonical format in docs/superpowers/plans/2026-10-29-xfdf.md;
 * it is an independent second implementation, not SDK output.
 *
 * Usage: node conformance/xfdf/make-xfdf.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// PDF text strings as UTF-16BE with a byte-order mark, so any text survives.
const pdfText = (s) => `<FEFF${[...s].map((c) => {
  const code = c.codePointAt(0);
  if (code > 0xffff) throw new Error('BMP only');
  return code.toString(16).padStart(4, '0').toUpperCase();
}).join('')}>`;
const num = (n) => (Number.isInteger(n) ? String(n) : String(n));

const AUTHOR = 'Zoë & "Co" <ok>';
const MODIFIED = 'D:20261029120000Z';
const CREATED = 'D:20261028090000Z';

// Annotations in /Annots order after the page's widgets. Colours use 0 and 1 only, so no
// platform rounds a channel differently.
const ANNOTS = [
  { page: 0, xfdf: 'highlight', subtype: 'Highlight', rect: [72, 700, 200, 714], color: [1, 1, 0],
    quads: [72, 714, 200, 714, 72, 700, 200, 700], contents: 'Check this' },
  { page: 0, xfdf: 'underline', subtype: 'Underline', rect: [72, 680, 200, 694], color: [0, 0, 1],
    quads: [72, 694, 200, 694, 72, 680, 200, 680], contents: 'Underlined' },
  { page: 0, xfdf: 'strikeout', subtype: 'StrikeOut', rect: [72, 660, 200, 674], color: [1, 0, 0],
    quads: [72, 674, 200, 674, 72, 660, 200, 660], contents: 'Struck' },
  { page: 0, xfdf: 'squiggly', subtype: 'Squiggly', rect: [72, 640, 200, 654], color: [0, 1, 0],
    quads: [72, 654, 200, 654, 72, 640, 200, 640], contents: 'Wavy' },
  { page: 0, xfdf: 'ink', subtype: 'Ink', rect: [300, 600, 400, 700], color: [0, 0, 0], width: 2,
    strokes: [[[300, 600], [350, 650], [400, 700]], [[300, 700], [400, 600]]], contents: 'Signed off' },
  { page: 0, xfdf: 'text', subtype: 'Text', rect: [450, 700, 470, 720], color: [1, 1, 0], icon: 'Comment',
    contents: 'A note & a <tag>' },
  { page: 0, xfdf: 'square', subtype: 'Square', rect: [72, 500, 172, 560], color: [1, 0, 0], contents: 'Box' },
  { page: 0, xfdf: 'circle', subtype: 'Circle', rect: [200, 500, 260, 560], color: [0, 0, 1], contents: 'Ring' },
  { page: 1, xfdf: 'line', subtype: 'Line', rect: [72, 600, 300, 700], color: [0, 0, 0],
    line: [[72, 600], [300, 700]], contents: 'Arrow' },
  { page: 1, xfdf: 'freetext', subtype: 'FreeText', rect: [72, 500, 300, 540], color: [0, 0, 0],
    da: '/Helv 12 Tf 0 g', contents: 'Typed text' },
  { page: 1, xfdf: 'stamp', subtype: 'Stamp', rect: [350, 500, 500, 560], color: [1, 0, 0], stampName: 'Approved',
    contents: 'Approved' },
  { page: 1, xfdf: null, subtype: 'Link', rect: [72, 400, 200, 414], uri: 'https://example.com' },
  { page: 1, xfdf: 'highlight', subtype: 'Highlight', rect: [72, 300, 200, 314], color: [1, 1, 0], opacity: 0.5,
    flags: 0, quads: [72, 314, 200, 314, 72, 300, 200, 300], contents: 'Faint' },
];

function buildPdf({ blank }) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesId = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const empty = () => add('<< /Length 0 /Type /XObject /Subtype /Form /BBox [0 0 16 16] >>\nstream\n\nendstream');
  const page0 = add(null);
  const page1 = add(null);
  const annots = [[], []];
  const fields = [];
  const da = '/DA (/Helv 10 Tf 0 g)';
  const widget = (page, rect, extra) => `/Type /Annot /Subtype /Widget /Rect [${rect.join(' ')}] /P ${page === 0 ? page0 : page1} 0 R /F 4 ${extra}`;

  // customer.name: a parent field with one terminal kid, so the full name is hierarchical.
  const customer = add(null);
  const name = add(`<< ${widget(0, [260, 740, 500, 756], da)} /T (name) /FT /Tx /Parent ${customer} 0 R /V ${pdfText(blank ? '' : AUTHOR)} >>`);
  objects[customer - 1] = `<< /T (customer) /Kids [${name} 0 R] >>`;
  annots[0].push(name);
  fields.push(customer);

  const on = blank ? 'Off' : 'Yes';
  const agree = add(`<< ${widget(0, [260, 720, 276, 736], da)} /T (agree) /FT /Btn /V /${on} /AS /${on} /AP << /N << /Yes ${empty()} 0 R /Off ${empty()} 0 R >> >> >>`);
  annots[0].push(agree);
  fields.push(agree);

  const country = add(`<< ${widget(0, [260, 700, 500, 716], da)} /T (country) /FT /Ch /Ff 131072 /Opt [(Austria) (Germany) (Switzerland)] /V ${blank ? '()' : '(Germany)'} >>`);
  annots[0].push(country);
  fields.push(country);

  // size: a radio group of three, M on.
  const size = add(null);
  const radios = ['S', 'M', 'L'].map((value, i) => {
    const state = !blank && value === 'M' ? value : 'Off';
    const id = add(`<< ${widget(0, [260 + i * 30, 680, 276 + i * 30, 696], da)} /Parent ${size} 0 R /AS /${state} /AP << /N << /${value} ${empty()} 0 R /Off ${empty()} 0 R >> >> >>`);
    annots[0].push(id);
    return id;
  });
  objects[size - 1] = `<< /T (size) /FT /Btn /Ff 49152 /V /${blank ? 'Off' : 'M'} /Kids [${radios.map((r) => `${r} 0 R`).join(' ')}] >>`;
  fields.push(size);

  // ref: one text field shown on both pages.
  const ref = add(null);
  const ref0 = add(`<< ${widget(0, [260, 660, 400, 676], da)} /Parent ${ref} 0 R >>`);
  const ref1 = add(`<< ${widget(1, [260, 740, 400, 756], da)} /Parent ${ref} 0 R >>`);
  objects[ref - 1] = `<< /T (ref) /FT /Tx /V (${blank ? '' : 'R-17'}) /Kids [${ref0} 0 R ${ref1} 0 R] >>`;
  annots[0].push(ref0);
  fields.push(ref);

  const submit = add(`<< ${widget(0, [260, 620, 340, 640], da)} /T (submit) /FT /Btn /Ff 65536 >>`);
  annots[0].push(submit);
  fields.push(submit);
  annots[1].push(ref1);

  if (!blank) {
    ANNOTS.forEach((a, i) => {
      const parts = [`/Type /Annot /Subtype /${a.subtype}`, `/Rect [${a.rect.join(' ')}]`, `/P ${a.page === 0 ? page0 : page1} 0 R`];
      if (a.subtype === 'Link') {
        parts.push(`/A << /S /URI /URI (${a.uri}) >> /Border [0 0 0]`);
      } else {
        parts.push(`/F ${a.flags ?? 4}`, `/C [${a.color.join(' ')}]`, `/NM (pdfcora-${i + 1})`, `/T ${pdfText(AUTHOR)}`,
          `/M (${MODIFIED})`, `/CreationDate (${CREATED})`, `/Contents ${pdfText(a.contents)}`);
        if (a.opacity !== undefined) parts.push(`/CA ${a.opacity}`);
        if (a.quads) parts.push(`/QuadPoints [${a.quads.join(' ')}]`);
        if (a.strokes) parts.push(`/InkList [${a.strokes.map((s) => `[${s.flat().join(' ')}]`).join(' ')}] /Border [0 0 ${a.width}]`);
        if (a.icon) parts.push(`/Name /${a.icon}`);
        if (a.line) parts.push(`/L [${a.line.flat().join(' ')}]`);
        if (a.da) parts.push(`/DA (${a.da})`);
        if (a.stampName) parts.push(`/Name /${a.stampName}`);
      }
      annots[a.page].push(add(`<< ${parts.join(' ')} >>`));
    });
  }

  const pageBody = (id, list) => `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> >> /Annots [${list.map((a) => `${a} 0 R`).join(' ')}] >>`;
  objects[page0 - 1] = pageBody(page0, annots[0]);
  objects[page1 - 1] = pageBody(page1, annots[1]);
  const acroForm = add(`<< /Fields [${fields.map((f) => `${f} 0 R`).join(' ')}] /DA (/Helv 10 Tf 0 g) ` +
    `/DR << /Font << /Helv ${font} 0 R >> >> /NeedAppearances true >>`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /AcroForm ${acroForm} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${page0} 0 R ${page1} 0 R] /Count 2 >>`;

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
  return pdf;
}

// The canonical XFDF for source.pdf, written from the same data.
const attr = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const text = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase()).join('');

function expectedExport() {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">'];
  out.push('  <fields>',
    '    <field name="customer">',
    '      <field name="name">',
    `        <value>${text(AUTHOR)}</value>`,
    '      </field>',
    '    </field>',
    '    <field name="agree">', '      <value>Yes</value>', '    </field>',
    '    <field name="country">', '      <value>Germany</value>', '    </field>',
    '    <field name="size">', '      <value>M</value>', '    </field>',
    '    <field name="ref">', '      <value>R-17</value>', '    </field>',
    '  </fields>');
  out.push('  <annots>');
  ANNOTS.filter((a) => a.xfdf).forEach((a) => {
    const i = ANNOTS.indexOf(a);
    const attrs = [['page', a.page], ['rect', a.rect.map(num).join(',')], ['color', hex(a.color)]];
    if (a.opacity !== undefined) attrs.push(['opacity', num(a.opacity)]);
    if ((a.flags ?? 4) !== 0) attrs.push(['flags', 'print']);
    attrs.push(['name', `pdfcora-${i + 1}`], ['title', AUTHOR], ['date', MODIFIED], ['creationdate', CREATED]);
    if (a.quads) attrs.push(['coords', a.quads.map(num).join(',')]);
    if (a.strokes) attrs.push(['width', num(a.width)]);
    if (a.icon) attrs.push(['icon', a.icon]);
    if (a.line) attrs.push(['start', a.line[0].join(',')], ['end', a.line[1].join(',')]);
    out.push(`    <${a.xfdf} ${attrs.map(([k, v]) => `${k}="${attr(String(v))}"`).join(' ')}>`);
    if (a.strokes) {
      out.push('      <inklist>');
      for (const s of a.strokes) out.push(`        <gesture>${s.map((p) => p.join(',')).join(';')}</gesture>`);
      out.push('      </inklist>');
    }
    out.push(`      <contents>${text(a.contents)}</contents>`);
    if (a.da) out.push(`      <defaultappearance>${text(a.da)}</defaultappearance>`);
    out.push(`    </${a.xfdf}>`);
  });
  out.push('  </annots>', '</xfdf>');
  return out.join('\n') + '\n';
}

writeFileSync(join(HERE, 'source.pdf'), buildPdf({ blank: false }), 'latin1');
writeFileSync(join(HERE, 'source-blank.pdf'), buildPdf({ blank: true }), 'latin1');
writeFileSync(join(HERE, 'expected-export.xfdf'), expectedExport());
console.log('wrote source.pdf, source-blank.pdf, expected-export.xfdf');
