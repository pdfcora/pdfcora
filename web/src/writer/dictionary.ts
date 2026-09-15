/**
 * A minimal PDF dictionary reader.
 *
 * Shared by the trailer scan and the cross-reference walk so the two cannot drift. It
 * understands the value forms that appear in trailers, xref stream dictionaries and
 * object headers — numbers, names, references, arrays, strings and nested dictionaries —
 * and preserves nothing else.
 */

import type { PdfValue } from './values.js';
import { hexString, name, raw, ref } from './values.js';

export type Dictionary = Record<string, PdfValue>;

/** Reads the dictionary beginning at `start`, which must be a `<<`. */
export function parseDictionaryAt(text: string, start: number): Dictionary {
  if (start < 0) throw new Error('dictionary: no `<<` found');
  return parseDictionary(text, start);
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
    if (end < 0) throw new Error('unterminated hex string');
    return [hexString(hexBytes(text.slice(i + 1, end))), end + 1];
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
    // Kept as written, escapes and all: decoding and re-encoding would change the bytes
    // of any string a rewritten object carries forward.
    return [raw(latin1(text.slice(i, j))), j];
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

function hexBytes(digits: string): Uint8Array {
  const clean = digits.replace(/[^0-9a-fA-F]/g, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const out = new Uint8Array(padded.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = parseInt(padded.slice(k * 2, k * 2 + 2), 16);
  return out;
}

function latin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let k = 0; k < value.length; k++) out[k] = value.charCodeAt(k) & 0xff;
  return out;
}

const decodeName = (value: string) =>
  value.replace(/#([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
