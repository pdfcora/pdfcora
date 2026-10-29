import type { PdfDocument } from '../document.js';
import type { PdfAnnotation, PdfColor, PdfFormField } from '../types.js';
import { readAnnotationEntries, type AnnotationEntries } from './annotationEntries.js';
import { saveHandle } from '../save.js';
import { annotsOf, listPages, readCatalog, readObject } from '../writer/read.js';
import { buildXref } from '../writer/xref.js';
import { asRef, entryOf, type PdfValue } from '../writer/values.js';
import { escapeAttribute, escapeText, formatNumber } from './xml.js';

const FLAG_NAMES = ['invisible', 'hidden', 'print', 'nozoom', 'norotate', 'noview', 'readonly', 'locked',
  'togglenoview', 'lockedcontents'];

const ELEMENT: Partial<Record<PdfAnnotation['kind'], string>> = {
  highlight: 'highlight', underline: 'underline', strikeout: 'strikeout', squiggly: 'squiggly', ink: 'ink',
  note: 'text', square: 'square', circle: 'circle', line: 'line', freeText: 'freetext', stamp: 'stamp',
  fileAttachment: 'fileattachment',
};

const hex = (c: PdfColor) => '#' + [c.red, c.green, c.blue].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

/**
 * Each annotation's `/C`, keyed `page:index`, read from a full save of the document.
 *
 * PDFium's `FPDFAnnot_GetColor` refuses once an annotation has an appearance stream, and
 * PDFium generates one for most markup when a page with a form is loaded, so the colour
 * has to come from the dictionary itself. `/Annots` order is the index PDFium uses.
 */
async function annotationColors(document: PdfDocument): Promise<Map<string, PdfColor>> {
  const bytes = await document.run((h, m) => saveHandle(m, h, 2));
  const xref = await buildXref(bytes);
  const catalog = (await readCatalog(bytes)).value;
  const colors = new Map<string, PdfColor>();
  const pages = await listPages(bytes, xref, catalog);
  for (const [pageIndex, pageNumber] of pages.entries()) {
    const page = await readObject(bytes, xref, pageNumber);
    const annots = page ? await annotsOf(bytes, xref, page) : undefined;
    for (const [index, entry] of (annots ?? []).entries()) {
      const number = asRef(entry)?.[0];
      const dict: PdfValue | undefined = number !== undefined ? await readObject(bytes, xref, number) : entry;
      const color = dict ? colorOf(entryOf(dict, 'C')) : undefined;
      if (color) colors.set(`${pageIndex}:${index}`, color);
    }
  }
  return colors;
}

/** `/C` has 1 (grey), 3 (RGB) or 4 (CMYK) components; none means transparent. */
function colorOf(value: PdfValue | undefined): PdfColor | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number')) return undefined;
  const c = value as number[];
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  if (c.length === 1) return { red: byte(c[0]!), green: byte(c[0]!), blue: byte(c[0]!) };
  if (c.length === 3) return { red: byte(c[0]!), green: byte(c[1]!), blue: byte(c[2]!) };
  if (c.length === 4) {
    const k = 1 - c[3]!;
    return { red: byte((1 - c[0]!) * k), green: byte((1 - c[1]!) * k), blue: byte((1 - c[2]!) * k) };
  }
  return undefined;
}

/** A named node of the field tree; `values` set only on a field that carries a value. */
interface FieldNode { readonly name: string; values?: string[]; readonly children: FieldNode[] }

function fieldValues(widgets: PdfFormField[]): string[] | undefined {
  const first = widgets[0]!;
  switch (first.kind) {
    case 'text': return first.value === '' ? undefined : [first.value];
    case 'checkBox':
    case 'radioButton': {
      const on = widgets.find((w) => (w.kind === 'checkBox' || w.kind === 'radioButton') && w.isChecked);
      return [on && (on.kind === 'checkBox' || on.kind === 'radioButton') ? on.exportValue ?? 'Yes' : 'Off'];
    }
    case 'comboBox': return first.value === '' ? undefined : [first.value];
    case 'listBox': {
      const selected = first.selectedIndices.map((i) => first.options[i]).filter((o): o is string => o !== undefined);
      return selected.length > 0 ? selected : undefined;
    }
    default: return undefined;
  }
}

function fieldTree(byName: Map<string, PdfFormField[]>): FieldNode[] {
  const roots: FieldNode[] = [];
  for (const [fullName, widgets] of byName) {
    const values = fieldValues(widgets);
    if (!values) continue;
    let level = roots;
    let node: FieldNode | undefined;
    for (const part of fullName.split('.')) {
      node = level.find((n) => n.name === part);
      if (!node) { node = { name: part, children: [] }; level.push(node); }
      level = node.children;
    }
    node!.values = values;
  }
  return roots;
}

function writeFields(nodes: FieldNode[], depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  for (const node of nodes) {
    out.push(`${pad}<field name="${escapeAttribute(node.name)}">`);
    for (const value of node.values ?? []) out.push(`${pad}  <value>${escapeText(value)}</value>`);
    writeFields(node.children, depth + 1, out);
    out.push(`${pad}</field>`);
  }
}

function writeAnnotation(a: PdfAnnotation, element: string, e: AnnotationEntries, color: PdfColor | undefined,
                         out: string[]): void {
  const attrs: [string, string][] = [
    ['page', String(a.pageIndex)],
    ['rect', [a.rect.left, a.rect.bottom, a.rect.right, a.rect.top].map(formatNumber).join(',')],
  ];
  if (color) attrs.push(['color', hex(color)]);
  if (e.opacity !== undefined && e.opacity !== 1) attrs.push(['opacity', formatNumber(e.opacity)]);
  const flags = FLAG_NAMES.filter((_, bit) => (a.flags & (1 << bit)) !== 0);
  if (flags.length > 0) attrs.push(['flags', flags.join(',')]);
  if (e.name !== undefined) attrs.push(['name', e.name]);
  if (e.title !== undefined) attrs.push(['title', e.title]);
  if (e.modified !== undefined) attrs.push(['date', e.modified]);
  if (e.created !== undefined) attrs.push(['creationdate', e.created]);
  if (a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout' || a.kind === 'squiggly') {
    attrs.push(['coords', a.quads.flatMap((q) => [q.p1, q.p2, q.p3, q.p4]).flatMap((p) => [p.x, p.y]).map(formatNumber).join(',')]);
  }
  if (a.kind === 'ink' && e.borderWidth !== undefined) attrs.push(['width', formatNumber(e.borderWidth)]);
  if (a.kind === 'note' && e.icon !== undefined) attrs.push(['icon', e.icon]);
  if (a.kind === 'line' && e.line) {
    attrs.push(['start', `${formatNumber(e.line[0].x)},${formatNumber(e.line[0].y)}`]);
    attrs.push(['end', `${formatNumber(e.line[1].x)},${formatNumber(e.line[1].y)}`]);
  }

  out.push(`    <${element} ${attrs.map(([k, v]) => `${k}="${escapeAttribute(v)}"`).join(' ')}>`);
  if (a.kind === 'ink') {
    out.push('      <inklist>');
    for (const stroke of a.strokes) {
      out.push(`        <gesture>${stroke.map((p) => `${formatNumber(p.x)},${formatNumber(p.y)}`).join(';')}</gesture>`);
    }
    out.push('      </inklist>');
  }
  if (a.contents !== undefined) out.push(`      <contents>${escapeText(a.contents)}</contents>`);
  if (a.kind === 'freeText' && e.defaultAppearance !== undefined) {
    out.push(`      <defaultappearance>${escapeText(e.defaultAppearance)}</defaultappearance>`);
  }
  out.push(`    </${element}>`);
}

/** The document's form values and annotations as XFDF, in the canonical layout. */
export async function exportXfdf(document: PdfDocument): Promise<string> {
  const pageCount = await document.pageCount();
  const byName = new Map<string, PdfFormField[]>();
  const annots: string[] = [];
  let colors: Map<string, PdfColor> | undefined;

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const page = await document.page(pageIndex);
    const fields = [...await page.formFields()].sort((a, b) => a.annotationIndex - b.annotationIndex);
    for (const field of fields) {
      if (!field.name) continue;
      const widgets = byName.get(field.name);
      if (widgets) widgets.push(field); else byName.set(field.name, [field]);
    }
    for (const annotation of await page.annotations()) {
      const element = ELEMENT[annotation.kind];
      if (!element) continue;
      // The save behind the colour lookup is only paid when there is something to export.
      colors ??= await annotationColors(document);
      writeAnnotation(annotation, element, await readAnnotationEntries(document, pageIndex, annotation.index),
        colors.get(`${pageIndex}:${annotation.index}`) ?? annotation.color, annots);
    }
  }

  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">'];
  const fieldLines: string[] = [];
  writeFields(fieldTree(byName), 2, fieldLines);
  if (fieldLines.length > 0) out.push('  <fields>', ...fieldLines, '  </fields>');
  if (annots.length > 0) out.push('  <annots>', ...annots, '  </annots>');
  out.push('</xfdf>');
  return out.join('\n') + '\n';
}
