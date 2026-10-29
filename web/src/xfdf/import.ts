import type { PdfDocument } from '../document.js';
import type { PdfPage } from '../page.js';
import type {
  PdfColor, PdfFormField, PdfPoint, PdfQuad, PdfRect, PdfXfdfReport, PdfXfdfSkip, PdfXfdfSkipReason,
} from '../types.js';
import { PdfError } from '../errors.js';
import { writeAnnotationStrings } from './annotationEntries.js';
import { parseXml, type XmlElement } from './xml.js';

const SUPPORTED = new Set(['ink', 'text', 'highlight', 'underline', 'strikeout']);

/** A field with the values XFDF gives it, its name joined from the nested `<field>` elements. */
interface FieldValue { readonly name: string; readonly values: string[] }

function collectFields(element: XmlElement, prefix: string, out: FieldValue[]): void {
  for (const child of element.children) {
    if (child.name !== 'field') continue;
    const name = prefix ? `${prefix}.${child.attributes['name'] ?? ''}` : child.attributes['name'] ?? '';
    const values = child.children.filter((c) => c.name === 'value').map((c) => c.text);
    if (values.length > 0) out.push({ name, values });
    collectFields(child, name, out);
  }
}

const numbers = (text: string | undefined): number[] | undefined => {
  if (text === undefined) return undefined;
  const parts = text.split(/[,;\s]+/).filter((p) => p !== '').map(Number);
  return parts.length > 0 && parts.every(Number.isFinite) ? parts : undefined;
};

function colorOf(attributes: Record<string, string>): PdfColor | undefined {
  const match = /^#([0-9a-fA-F]{6})$/.exec(attributes['color'] ?? '');
  if (!match) return undefined;
  const v = parseInt(match[1]!, 16);
  const opacity = Number(attributes['opacity'] ?? '1');
  const alpha = Number.isFinite(opacity) ? Math.round(Math.min(1, Math.max(0, opacity)) * 255) : 255;
  return { red: (v >> 16) & 255, green: (v >> 8) & 255, blue: v & 255, alpha };
}

async function widgetsByName(document: PdfDocument): Promise<Map<string, { page: PdfPage; field: PdfFormField }[]>> {
  const byName = new Map<string, { page: PdfPage; field: PdfFormField }[]>();
  const count = await document.pageCount();
  for (let i = 0; i < count; i++) {
    const page = await document.page(i);
    for (const field of await page.formFields()) {
      if (!field.name) continue;
      const list = byName.get(field.name) ?? [];
      list.push({ page, field });
      byName.set(field.name, list);
    }
  }
  return byName;
}

/** Sets one XFDF field on every widget with its name. Resolves to a skip reason, or undefined when set. */
async function setField(widgets: { page: PdfPage; field: PdfFormField }[], values: string[]): Promise<PdfXfdfSkipReason | undefined> {
  if (widgets.some((w) => w.field.isReadOnly)) return 'readOnlyField';
  const value = values[0] ?? '';
  const first = widgets[0]!.field;
  try {
    switch (first.kind) {
      case 'text':
        for (const { page, field } of widgets) await page.setText(value, field.annotationIndex);
        return undefined;
      case 'checkBox': {
        for (const { page, field } of widgets) {
          if (field.kind !== 'checkBox') return 'invalidValue';
          const on = field.exportValue ?? 'Yes';
          if (value === 'Off') await page.setChecked(false, field.annotationIndex);
          else if (value === on || (field.exportValue === undefined && value === 'On')) await page.setChecked(true, field.annotationIndex);
          else return 'invalidValue';
        }
        return undefined;
      }
      case 'radioButton': {
        if (value === 'Off') {
          for (const { page, field } of widgets) await page.setChecked(false, field.annotationIndex);
          return undefined;
        }
        const match = widgets.find((w) => w.field.kind === 'radioButton' && w.field.exportValue === value);
        if (!match) return 'invalidValue';
        await match.page.setChecked(true, match.field.annotationIndex);
        return undefined;
      }
      case 'comboBox':
      case 'listBox': {
        const options = first.options;
        if (values.some((v) => !options.includes(v))) return 'invalidValue';
        for (const { page, field } of widgets) {
          if (first.kind === 'comboBox') await page.setOption(options.indexOf(value), true, field.annotationIndex);
          else for (const [i, option] of options.entries()) await page.setOption(i, values.includes(option), field.annotationIndex);
        }
        return undefined;
      }
      default:
        return 'invalidValue';
    }
  } catch {
    return 'writeFailed';
  }
}

/** Creates one annotation. Resolves to a skip reason, or undefined when added. */
async function addAnnotation(document: PdfDocument, pageCount: number, element: XmlElement): Promise<PdfXfdfSkip | undefined> {
  const a = element.attributes;
  const pageText = a['page'];
  const page = pageText !== undefined && /^\d+$/.test(pageText) ? Number(pageText) : undefined;
  const skip = (reason: PdfXfdfSkipReason): PdfXfdfSkip =>
    page === undefined ? { element: element.name, reason } : { element: element.name, page, reason };

  if (!SUPPORTED.has(element.name)) return skip('unsupportedType');
  if (page === undefined) return skip('missingAttribute');
  if (page >= pageCount) return skip('pageOutOfRange');

  const color = colorOf(a);
  const contents = element.children.find((c) => c.name === 'contents')?.text;
  let index: number;
  try {
    const target = await document.page(page);
    if (element.name === 'ink') {
      const gestures = element.children.find((c) => c.name === 'inklist')?.children.filter((c) => c.name === 'gesture') ?? [];
      const strokes = gestures.map((g) => numbers(g.text)).filter((n): n is number[] => n !== undefined && n.length >= 2)
        .map((n) => Array.from({ length: Math.floor(n.length / 2) }, (_, i): PdfPoint => ({ x: n[i * 2]!, y: n[i * 2 + 1]! })));
      if (strokes.length === 0) return skip('missingAttribute');
      const width = Number(a['width'] ?? '');
      index = await target.addInk(strokes, color ?? { red: 0, green: 0, blue: 0 }, Number.isFinite(width) && width > 0 ? width : 2);
    } else if (element.name === 'text') {
      const r = numbers(a['rect']);
      if (!r || r.length !== 4) return skip('missingAttribute');
      const rect: PdfRect = { left: r[0]!, bottom: r[1]!, right: r[2]!, top: r[3]! };
      index = color ? await target.addNote(rect, contents ?? '', color) : await target.addNote(rect, contents ?? '');
    } else {
      const c = numbers(a['coords']);
      if (!c || c.length < 8 || c.length % 8 !== 0) return skip('missingAttribute');
      const quads: PdfQuad[] = Array.from({ length: c.length / 8 }, (_, q) => ({
        p1: { x: c[q * 8]!, y: c[q * 8 + 1]! }, p2: { x: c[q * 8 + 2]!, y: c[q * 8 + 3]! },
        p3: { x: c[q * 8 + 4]!, y: c[q * 8 + 5]! }, p4: { x: c[q * 8 + 6]!, y: c[q * 8 + 7]! },
      }));
      const add = { highlight: target.addHighlight, underline: target.addUnderline, strikeout: target.addStrikeout }[
        element.name as 'highlight' | 'underline' | 'strikeout'].bind(target);
      index = color ? await add(quads, color) : await add(quads);
    }
    await writeAnnotationStrings(document, page, index, {
      NM: a['name'], T: a['title'], M: a['date'], CreationDate: a['creationdate'],
      Contents: element.name === 'text' ? undefined : contents,
    });
  } catch {
    return skip('writeFailed');
  }
  return undefined;
}

/**
 * Applies XFDF to the document: field values first, then annotations, in document order.
 * The whole input is parsed before anything is written, so malformed XML changes nothing.
 */
export async function importXfdf(document: PdfDocument, xml: string): Promise<PdfXfdfReport> {
  const root = parseXml(xml);
  if (root.name !== 'xfdf') throw PdfError.invalidOperation('not valid XFDF: the root element is not <xfdf>');

  const fields: FieldValue[] = [];
  for (const section of root.children.filter((c) => c.name === 'fields')) collectFields(section, '', fields);
  const annots = root.children.filter((c) => c.name === 'annots').flatMap((c) => c.children);

  const skipped: PdfXfdfSkip[] = [];
  let fieldsSet = 0;
  let annotationsAdded = 0;

  const widgets = fields.length > 0 ? await widgetsByName(document) : new Map();
  for (const field of fields) {
    const targets = widgets.get(field.name);
    const reason = targets ? await setField(targets, field.values) : 'unknownField';
    if (reason) skipped.push({ element: 'field', reason }); else fieldsSet++;
  }

  const pageCount = await document.pageCount();
  for (const element of annots) {
    const skip = await addAnnotation(document, pageCount, element);
    if (skip) skipped.push(skip); else annotationsAdded++;
  }
  return { fieldsSet, annotationsAdded, skipped };
}
