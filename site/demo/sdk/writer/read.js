/**
 * Reading existing objects out of a document.
 *
 * Signing must merge `/AcroForm` into the Catalog and a widget into a page's `/Annots`;
 * scrubbing must rewrite `/Info`. All are existing objects, and replacing one without
 * reading it first would discard everything else it holds.
 *
 * Only dictionaries are modelled. Stream bodies are located but not returned, because
 * nothing that rewrites an object needs to reconstruct one.
 */
import { parseContainerAt, parseDictionaryAt } from './dictionary.js';
import { buildXref, streamBytes } from './xref.js';
import { asName, asRef, entryOf } from './values.js';
const decoder = new TextDecoder('latin1');
/** How far past an object header to look for its dictionary. */
const WINDOW = 1 << 20;
export async function readObject(bytes, xref, number) {
    const entry = xref.get(number);
    if (!entry)
        return undefined;
    return 'offset' in entry
        ? readAtOffset(bytes, entry.offset, number)
        : readFromObjectStream(bytes, xref, entry.inObjectStream, entry.index);
}
/** `N G obj … endobj` at a known offset. */
function readAtOffset(bytes, offset, number) {
    if (offset <= 0 || offset >= bytes.length)
        return undefined;
    const window = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + WINDOW)));
    const header = /^\s*(\d+)\s+(\d+)\s+obj\b/.exec(window);
    // A wrong offset points at something that is not this object. Returning undefined is
    // right: a caller that then writes a replacement would otherwise corrupt the file.
    if (!header || Number(header[1]) !== number)
        return undefined;
    // Dictionaries and arrays are modelled; a number or string here must not be mistaken for the
    // next object's dictionary.
    const at = firstNonSpace(window, header[0].length);
    if (!window.startsWith('<<', at) && window[at] !== '[')
        return undefined;
    return parseContainerAt(window, at);
}
/**
 * An object inside a compressed object stream.
 *
 * The stream begins with `/N` pairs of "object number, offset", after which `/First`
 * marks where the objects themselves start.
 */
async function readFromObjectStream(bytes, xref, streamNumber, index) {
    const entry = xref.get(streamNumber);
    if (!entry || !('offset' in entry))
        return undefined;
    const window = decoder.decode(bytes.subarray(entry.offset, Math.min(bytes.length, entry.offset + WINDOW)));
    const dictionaryAt = window.indexOf('<<');
    if (dictionaryAt < 0)
        return undefined;
    const dictionary = parseDictionaryAt(window, dictionaryAt);
    const count = numberOf(dictionary.N);
    const first = numberOf(dictionary.First);
    if (count === undefined || first === undefined)
        return undefined;
    if (index >= count)
        return undefined;
    let data;
    try {
        data = await streamBytes(bytes, entry.offset, window, dictionary);
    }
    catch {
        return undefined;
    }
    const header = decoder.decode(data.subarray(0, first));
    const numbers = header.trim().split(/\s+/).map(Number);
    // Pairs, so the offset of entry `index` is at 2 * index + 1.
    const offset = numbers[index * 2 + 1];
    if (offset === undefined || !Number.isFinite(offset))
        return undefined;
    const body = decoder.decode(data.subarray(first + offset));
    const at = firstNonSpace(body, 0);
    if (!body.startsWith('<<', at) && body[at] !== '[')
        return undefined;
    return parseContainerAt(body, at);
}
/** The document Catalog, with the object number so it can be rewritten. */
export async function readCatalog(bytes) {
    const xref = await buildXref(bytes);
    const number = await catalogNumber(bytes, xref);
    const value = await readObject(bytes, xref, number);
    if (!value)
        throw new Error(`read: catalog object ${number} is unreadable`);
    return { number, value };
}
async function catalogNumber(bytes, xref) {
    // The trailer's /Root is authoritative, and scanTrailer already resolves it.
    const trailerRoot = rootFromTrailer(bytes);
    if (trailerRoot !== undefined)
        return trailerRoot;
    // Some malformed files have no usable /Root. Finding the object that calls itself a
    // Catalog is a last resort, and better than failing outright.
    for (const number of xref.keys()) {
        const value = await readObject(bytes, xref, number);
        if (value && asName(entryOf(value, 'Type') ?? null) === 'Catalog')
            return number;
    }
    throw new Error('read: no /Root and no object claims to be a Catalog');
}
function rootFromTrailer(bytes) {
    // Reuse the same walk the xref builder does rather than re-finding the trailer.
    const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - (1 << 16))));
    const match = /\/Root\s+(\d+)\s+(\d+)\s+R/g;
    let last = null;
    for (let found = match.exec(tail); found; found = match.exec(tail))
        last = found;
    if (last)
        return Number(last[1]);
    // An xref-stream file keeps /Root in the stream dictionary, which may sit anywhere.
    const whole = decoder.decode(bytes);
    const anywhere = /\/Root\s+(\d+)\s+(\d+)\s+R/g;
    let found = null;
    for (let m = anywhere.exec(whole); m; m = anywhere.exec(whole))
        found = m;
    return found ? Number(found[1]) : undefined;
}
/** The object number a dictionary's `key` refers to, when it is a reference. */
export function refNumber(value, key) {
    const target = entryOf(value, key);
    return target ? asRef(target)?.[0] : undefined;
}
const numberOf = (value) => typeof value === 'number' ? value : undefined;
/** The object numbers of the document's pages, in page order. */
export async function listPages(bytes, xref, catalog) {
    const pages = [];
    const seen = new Set();
    const visit = async (number, depth) => {
        if (depth > 32 || seen.has(number))
            return; // malformed trees can cycle
        seen.add(number);
        const node = await readObject(bytes, xref, number);
        if (!node)
            return;
        if (asName(entryOf(node, 'Type') ?? null) === 'Page') {
            pages.push(number);
            return;
        }
        const kids = entryOf(node, 'Kids');
        if (!Array.isArray(kids))
            return;
        for (const kid of kids) {
            const kidNumber = asRef(kid)?.[0];
            if (kidNumber !== undefined)
                await visit(kidNumber, depth + 1);
        }
    };
    const root = refNumber(catalog, 'Pages');
    if (root !== undefined)
        await visit(root, 0);
    return pages;
}
function firstNonSpace(text, from) {
    let i = from;
    while (i < text.length && /[\s\0]/.test(text[i]))
        i++;
    return i;
}
const asDictionary = (value) => value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
/** `/AcroForm` may be an inline dictionary or a reference; real files use both. */
export async function acroFormOf(bytes, xref, catalog) {
    const number = refNumber(catalog, 'AcroForm');
    if (number !== undefined) {
        const value = await readObject(bytes, xref, number);
        return value ? asDictionary(value) : undefined;
    }
    const inline = entryOf(catalog, 'AcroForm');
    return inline ? asDictionary(inline) : undefined;
}
/** `/Annots` may likewise be an inline array or a reference to one. */
export async function annotsOf(bytes, xref, page) {
    const inline = entryOf(page, 'Annots');
    if (Array.isArray(inline))
        return [...inline];
    const number = refNumber(page, 'Annots');
    if (number === undefined)
        return undefined;
    const value = await readObject(bytes, xref, number);
    return Array.isArray(value) ? [...value] : undefined;
}
//# sourceMappingURL=read.js.map