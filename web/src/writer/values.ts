/**
 * Serialising PDF values.
 *
 * PDFium cannot create dictionaries, so anything this SDK must write into a document —
 * a signature dictionary, a replacement /Info — is built here and appended as an
 * incremental update. This module only writes; nothing here parses.
 */

const NAME = Symbol('name');
const REF = Symbol('ref');
const HEX = Symbol('hex');
const RAW = Symbol('raw');

export interface PdfName { readonly [NAME]: string }
export interface PdfRef { readonly [REF]: readonly [number, number] }
export interface PdfHexString { readonly [HEX]: Uint8Array }
/** Bytes written verbatim — used for stream bodies, which are not PDF values. */
export interface PdfRaw { readonly [RAW]: Uint8Array }

export type PdfValue =
  | number | boolean | null | string
  | PdfName | PdfRef | PdfHexString | PdfRaw
  | readonly PdfValue[]
  | { readonly [key: string]: PdfValue };

export const name = (value: string): PdfName => ({ [NAME]: value });
export const ref = (objectNumber: number, generation = 0): PdfRef =>
  ({ [REF]: [objectNumber, generation] });
export const hexString = (bytes: Uint8Array): PdfHexString => ({ [HEX]: bytes });
export const raw = (bytes: Uint8Array): PdfRaw => ({ [RAW]: bytes });

export interface SerializeOptions {
  /** Wrap the value as an indirect object: `N 0 obj … endobj`. */
  readonly objectNumber?: number;
  readonly generation?: number;
}

// A name is terminated by whitespace or a delimiter, so those bytes must be escaped
// rather than written literally.
const NAME_SAFE = /[^\x21-\x7e]|[()<>[\]{}/%#]/g;

function encodeName(value: string): string {
  return '/' + value.replace(NAME_SAFE, (c) =>
    '#' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function encodeLiteralString(value: string): Uint8Array {
  // PDF text strings are PDFDocEncoding unless they open with a UTF-16BE byte order
  // mark. Rather than model PDFDocEncoding, anything outside ASCII takes the BOM path.
  if (/[^\x00-\x7f]/.test(value)) {
    const out = new Uint8Array(2 + value.length * 2);
    let i = 0;
    out[i++] = 0xfe; out[i++] = 0xff;
    for (const unit of utf16Units(value)) { out[i++] = unit >> 8; out[i++] = unit & 0xff; }
    return concat([ascii('<'), hex(out.subarray(0, i)), ascii('>')]);
  }
  const escaped = value.replace(/[\\()\r\n\t\b\f]/g, (c) =>
    ({ '\\': '\\\\', '(': '\\(', ')': '\\)', '\r': '\\r', '\n': '\\n',
       '\t': '\\t', '\b': '\\b', '\f': '\\f' })[c] as string);
  return ascii('(' + escaped + ')');
}

function* utf16Units(value: string): Generator<number> {
  for (let i = 0; i < value.length; i++) yield value.charCodeAt(i);
}

const ascii = (value: string) => new TextEncoder().encode(value);

function hex(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    out[i * 2] = HEX_DIGITS[byte >> 4]!;
    out[i * 2 + 1] = HEX_DIGITS[byte & 0x0f]!;
  }
  return out;
}
const HEX_DIGITS = ascii('0123456789ABCDEF');

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function encode(value: PdfValue): Uint8Array {
  if (value === null) return ascii('null');
  if (typeof value === 'boolean') return ascii(value ? 'true' : 'false');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot serialise ${value} as a PDF number`);
    return ascii(Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))));
  }
  if (typeof value === 'string') return encodeLiteralString(value);
  if (Array.isArray(value)) {
    const items = (value as readonly PdfValue[]).map(encode);
    return concat([ascii('['), joinWithSpace(items), ascii(']')]);
  }
  const record = value as Record<symbol, unknown>;
  if (NAME in record) return ascii(encodeName(record[NAME] as string));
  if (REF in record) {
    const [n, generation] = record[REF] as [number, number];
    return ascii(`${n} ${generation} R`);
  }
  if (HEX in record) return concat([ascii('<'), hex(record[HEX] as Uint8Array), ascii('>')]);
  if (RAW in record) return record[RAW] as Uint8Array;

  const entries = Object.entries(value as Record<string, PdfValue>);
  const parts = entries.map(([key, item]) =>
    concat([ascii(encodeName(key)), ascii(' '), encode(item)]));
  return concat([ascii('<<'), joinWithSpace(parts), ascii('>>')]);
}

function joinWithSpace(parts: readonly Uint8Array[]): Uint8Array {
  const spaced: Uint8Array[] = [];
  parts.forEach((part, index) => {
    if (index > 0) spaced.push(ascii(' '));
    spaced.push(part);
  });
  return concat(spaced);
}

export function serialize(value: PdfValue, options: SerializeOptions = {}): Uint8Array {
  const body = encode(value);
  if (options.objectNumber === undefined) return body;
  return concat([
    ascii(`${options.objectNumber} ${options.generation ?? 0} obj\n`),
    body,
    ascii('\nendobj\n'),
  ]);
}
