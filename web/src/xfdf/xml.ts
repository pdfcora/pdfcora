import { PdfError } from '../errors.js';

/** One XML element: its attributes, child elements and the text directly inside it. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlElement[];
  text: string;
}

export const XFDF_MAX_BYTES = 10 * 1024 * 1024;
/** Real XFDF nests a handful of levels; a limit keeps hostile input from exhausting the stack. */
export const XFDF_MAX_DEPTH = 64;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const fail = (why: string): never => { throw PdfError.invalidOperation(`not valid XFDF: ${why}`); };

/**
 * Parses the subset of XML that XFDF uses: elements, attributes, text, CDATA, comments,
 * processing instructions and the five predefined entities plus numeric ones.
 *
 * Node has no DOMParser, and XFDF comes from outside, so anything that could reach beyond
 * the text — a DOCTYPE, an entity declaration, an unknown entity — is refused outright.
 */
export function parseXml(text: string): XmlElement {
  if (new TextEncoder().encode(text).length > XFDF_MAX_BYTES) fail('larger than 10 MiB');
  // XML reads every literal CR and CRLF as LF; a CR meant as data is written &#13;.
  const input = text.replace(/\r\n?/g, '\n');
  if (input.includes('<!DOCTYPE') || input.includes('<!ENTITY')) fail('DOCTYPE and entity declarations are not allowed');

  let at = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const decode = (raw: string): string => raw.replace(/&(?:([^;&\s<]*);)?/g, (whole, name: string | undefined) => {
    if (name === undefined) return fail('a bare & must be written &amp;');
    if (name.startsWith('#x')) return codePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return codePoint(parseInt(name.slice(1), 10));
    const value = ENTITIES[name];
    return value ?? fail(`unknown entity ${whole}`);
  });

  const appendText = (raw: string) => {
    const current = stack[stack.length - 1];
    if (current) current.text += raw;
    else if (raw.trim() !== '') fail('text outside the root element');
  };

  while (at < input.length) {
    const open = input.indexOf('<', at);
    if (open < 0) { appendText(decode(input.slice(at))); break; }
    if (open > at) appendText(decode(input.slice(at, open)));

    if (input.startsWith('<!--', open)) {
      const end = input.indexOf('-->', open + 4);
      if (end < 0) fail('unclosed comment');
      at = end + 3;
    } else if (input.startsWith('<![CDATA[', open)) {
      const end = input.indexOf(']]>', open + 9);
      if (end < 0) fail('unclosed CDATA');
      appendText(input.slice(open + 9, end));
      at = end + 3;
    } else if (input.startsWith('<?', open)) {
      const end = input.indexOf('?>', open + 2);
      if (end < 0) fail('unclosed processing instruction');
      at = end + 2;
    } else if (input.startsWith('</', open)) {
      const end = input.indexOf('>', open);
      if (end < 0) fail('unclosed end tag');
      const name = input.slice(open + 2, end).trim();
      const current = stack.pop();
      if (!current || current.name !== name) fail(`unexpected </${name}>`);
      at = end + 1;
    } else {
      const end = findTagEnd(input, open);
      const selfClosing = input[end - 1] === '/';
      const body = input.slice(open + 1, selfClosing ? end - 1 : end);
      const element = parseTag(body, decode);
      if (stack.length >= XFDF_MAX_DEPTH) fail(`nested deeper than ${XFDF_MAX_DEPTH} levels`);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else if (root) fail('more than one root element');
      else root = element;
      if (!selfClosing) stack.push(element);
      at = end + 1;
    }
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1]!.name}> is not closed`);
  return root ?? fail('no root element');
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) fail('invalid character reference');
  return String.fromCodePoint(value);
}

/** The `>` closing a start tag, skipping any inside quoted attribute values. */
function findTagEnd(input: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < input.length; i++) {
    const c = input[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
    else if (c === '<') fail('"<" inside a tag');
  }
  return fail('unclosed start tag');
}

function parseTag(body: string, decode: (raw: string) => string): XmlElement {
  const name = /^[^\s/>]+/.exec(body)?.[0] ?? fail('a tag without a name');
  const attributes: Record<string, string> = {};
  const pattern = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/y;
  let at = name.length;
  while (at < body.length) {
    if (body.slice(at).trim() === '') break;
    pattern.lastIndex = at;
    const match = pattern.exec(body);
    if (!match) fail(`malformed attributes in <${name}>`);
    const key = match![1]!;
    if (key in attributes) fail(`duplicate attribute ${key}`);
    // XML turns literal newlines and tabs in an attribute into spaces; character
    // references survive, which is how this writer stores them.
    attributes[key] = decode((match![3] ?? match![4] ?? '').replace(/[\n\t]/g, ' '));
    at = pattern.lastIndex;
  }
  return { name, attributes, children: [], text: '' };
}

// Line breaks and tabs are written as character references, because an XML reader would
// otherwise turn a CR into LF, and a newline or tab in an attribute into a space.
export const escapeAttribute = (s: string): string =>
  s.replace(/[&<>"'\r\n\t]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;', '\n': '&#10;', '\t': '&#9;',
  }[c]!));

export const escapeText = (s: string): string =>
  s.replace(/[&<>\r]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;' }[c]!));

/** At most four decimals, no trailing zeros, no exponent, and never "-0". */
export function formatNumber(n: number): string {
  const fixed = n.toFixed(4).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}
