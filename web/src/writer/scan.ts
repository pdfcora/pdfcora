/**
 * Reading just enough of an existing PDF to append to it.
 *
 * This is deliberately not a PDF parser. To write an incremental update we need four
 * things — where the last cross-reference section starts, which style it uses, the
 * next free object number, and the trailer entries to carry forward — and nothing else.
 */

import type { PdfValue } from './values.js';
import { name, ref } from './values.js';

export type XrefStyle = 'table' | 'stream';

export interface TrailerInfo {
  readonly startXref: number;
  readonly style: XrefStyle;
  /** One past the highest object number in use. */
  readonly size: number;
  /** Highest object number actually present, which /Size may understate. */
  readonly highestObject: number;
  readonly root: PdfValue;
  readonly info?: PdfValue;
  readonly id?: PdfValue;
}

const decoder = new TextDecoder('latin1');

export function scanTrailer(bytes: Uint8Array): TrailerInfo {
  const startXref = findStartXref(bytes);
  const dictionary = readDictionaryAt(bytes, startXref);

  if ('Encrypt' in dictionary) {
    // Strings in appended objects would have to be encrypted with the document key.
    // Writing them in the clear produces a file that opens and then shows mojibake,
    // which is worse than refusing.
    throw new Error('cannot append to an encrypted document');
  }

  const size = numberOf(dictionary.Size);
  if (size === undefined) throw new Error('trailer has no /Size');
  if (!dictionary.Root) throw new Error('trailer has no /Root');

  return {
    startXref,
    style: dictionary[STYLE] as XrefStyle,
    size,
    highestObject: highestObjectNumber(bytes, size),
    root: dictionary.Root,
    info: dictionary.Info,
    id: dictionary.ID,
  };
}

/**
 * Where the next object this writer adds should be numbered.
 *
 * Not simply /Size: real files disagree with their own trailer. `bug_455199.pdf`
 * declares /Size 6 while its table lists objects 0-6, so trusting /Size overwrites a
 * live object — in that file, the page content stream.
 */
export function nextObjectNumber(info: TrailerInfo): number {
  return Math.max(info.size, info.highestObject + 1);
}

/** Scans for `N G obj` headers, which is the only account of object numbers that
 *  cannot disagree with itself. Objects inside object streams are not visible here,
 *  which is why /Size still participates in the maximum. */
function highestObjectNumber(bytes: Uint8Array, size: number): number {
  const text = decoder.decode(bytes);
  let highest = size - 1;
  const header = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
  for (let m = header.exec(text); m; m = header.exec(text)) {
    const n = plausible(m[1]!);
    if (n !== undefined) highest = Math.max(highest, n);
  }
  const subsection = /\bxref\s*\n\s*(\d+)\s+(\d+)/g;
  for (let m = subsection.exec(text); m; m = subsection.exec(text)) {
    const first = plausible(m[1]!);
    const count = plausible(m[2]!);
    if (first !== undefined && count !== undefined) highest = Math.max(highest, first + count - 1);
  }
  return highest;
}

/**
 * The scan runs over the whole file, binary stream data included, so it finds byte
 * sequences that merely look like object headers. The spec caps object numbers at
 * 8,388,607; anything above that is a false match, not a document with ten million
 * objects.
 */
const MAX_OBJECT_NUMBER = 8_388_607;

function plausible(digits: string): number | undefined {
  const value = Number(digits);
  return Number.isInteger(value) && value >= 0 && value <= MAX_OBJECT_NUMBER ? value : undefined;
}

const STYLE = '__style';

function findStartXref(bytes: Uint8Array): number {
  // The spec allows junk after %%EOF, so search backwards from the end.
  const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const match = /startxref\s+(\d+)/g;
  let offset: number | undefined;
  for (let found = match.exec(tail); found; found = match.exec(tail)) {
    offset = Number(found[1]);
  }
  if (offset === undefined) throw new Error('no startxref: not a PDF, or truncated');
  if (offset <= 0 || offset >= bytes.length) throw new Error(`startxref ${offset} is out of range`);
  return offset;
}

/**
 * Reads the trailer dictionary at `offset`, which is either a classic `xref` section
 * followed by `trailer <<…>>`, or a cross-reference stream whose own dictionary holds
 * the same entries. The stream body is never decoded: /Size and /Root live in the
 * dictionary either way.
 */
function readDictionaryAt(bytes: Uint8Array, offset: number): Record<string, PdfValue> {
  let window = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + 65536)));

  // startxref is not always exact. bug_455199.pdf points eight bytes early, into the
  // preceding "endobj". PDFium tolerates it, so this must too.
  if (!/^\s*(xref\b|<<)/.test(window)) {
    const near = /\bxref\b|<</.exec(window.slice(0, 512));
    if (near) window = window.slice(near.index);
  }

  if (/^\s*xref\b/.test(window)) {
    const at = window.indexOf('trailer');
    if (at < 0) throw new Error('xref table has no trailer');
    const parsed = parseDictionary(window, window.indexOf('<<', at));
    return { ...parsed, [STYLE]: 'table' as unknown as PdfValue };
  }

  const at = window.indexOf('<<');
  if (at < 0) throw new Error(`no dictionary at startxref ${offset}`);
  const parsed = parseDictionary(window, at);
  return { ...parsed, [STYLE]: 'stream' as unknown as PdfValue };
}

/**
 * A minimal dictionary reader. It understands the value forms that appear in a
 * trailer — numbers, names, references, arrays, strings and nested dictionaries —
 * and preserves nothing else, because nothing else is carried forward.
 */
function parseDictionary(text: string, start: number): Record<string, PdfValue> {
  if (text.slice(start, start + 2) !== '<<') throw new Error('expected a dictionary');
  const result: Record<string, PdfValue> = {};
  let i = start + 2;

  for (;;) {
    i = skipSpace(text, i);
    if (text.startsWith('>>', i)) return result;
    if (i >= text.length) throw new Error('unterminated dictionary');
    if (text[i] !== '/') throw new Error(`expected a key at ${i}, found ${text[i]}`);

    const keyEnd = endOfToken(text, i + 1);
    const key = decodeName(text.slice(i + 1, keyEnd));
    i = skipSpace(text, keyEnd);
    const [value, next] = parseValue(text, i);
    result[key] = value;
    i = next;
  }
}

function parseValue(text: string, start: number): [PdfValue, number] {
  const i = skipSpace(text, start);
  const c = text[i];

  if (c === '<' && text[i + 1] === '<') {
    const end = matchingBracket(text, i);
    return [parseDictionary(text, i), end];
  }
  if (c === '<') {
    const end = text.indexOf('>', i);
    return [{ __hexLiteral: text.slice(i, end + 1) } as unknown as PdfValue, end + 1];
  }
  if (c === '[') {
    const items: PdfValue[] = [];
    let j = i + 1;
    for (;;) {
      j = skipSpace(text, j);
      if (text[j] === ']') return [items, j + 1];
      if (j >= text.length) throw new Error('unterminated array');
      const [item, next] = parseValue(text, j);
      items.push(item);
      j = next;
    }
  }
  if (c === '(') {
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === '\\') { j++; continue; }
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) { j++; break; }
    }
    return [text.slice(i + 1, j - 1), j];
  }
  if (c === '/') {
    const end = endOfToken(text, i + 1);
    return [name(decodeName(text.slice(i + 1, end))), end];
  }

  const end = endOfToken(text, i);
  const token = text.slice(i, end);

  // "12 0 R" is a reference; "12 0" on its own is two numbers. Only the three-token
  // form may be consumed here, or array elements get swallowed.
  const reference = /^(\d+)\s+(\d+)\s+R\b/.exec(text.slice(i));
  if (reference) {
    return [ref(Number(reference[1]), Number(reference[2])), i + reference[0].length];
  }
  if (token === 'true') return [true, end];
  if (token === 'false') return [false, end];
  if (token === 'null') return [null, end];
  if (/^[+-]?[\d.]+$/.test(token)) return [Number(token), end];
  throw new Error(`unrecognised token "${token}" at ${i}`);
}

function matchingBracket(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text.startsWith('<<', i)) { depth++; i++; }
    else if (text.startsWith('>>', i)) { if (--depth === 0) return i + 2; i++; }
  }
  throw new Error('unterminated dictionary');
}

const SPACE = /[\s\0]/;
const DELIMITER = /[()<>[\]{}/%]/;

function skipSpace(text: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < text.length && SPACE.test(text[i]!)) i++;
    if (text[i] !== '%') return i;              // comments run to end of line
    while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
  }
}

function endOfToken(text: string, start: number): number {
  let i = start;
  while (i < text.length && !SPACE.test(text[i]!) && !DELIMITER.test(text[i]!)) i++;
  return i;
}

const decodeName = (value: string) =>
  value.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

function numberOf(value: PdfValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
