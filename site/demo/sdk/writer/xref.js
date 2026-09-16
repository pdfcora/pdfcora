/**
 * Locating every object in a document.
 *
 * Signing must merge `/AcroForm` into the Catalog and a widget into a page's `/Annots`,
 * and scrubbing must rewrite `/Info`. All of those are existing objects, so they have to
 * be found before they can be read.
 *
 * Both cross-reference styles are walked, following `/Prev` back through every appended
 * update. Newer sections win, which is exactly what an incremental update means.
 */
import { inflate, undoPredictor } from './inflate.js';
import { parseDictionaryAt } from './dictionary.js';
import { asName, entryOf } from './values.js';
const decoder = new TextDecoder('latin1');
/** How much of the file to decode when reading a section header or dictionary. */
const WINDOW = 1 << 20;
export async function buildXref(bytes) {
    const map = new Map();
    const visited = new Set();
    let offset = findStartXref(bytes);
    while (offset !== undefined) {
        // A malformed file can point /Prev at a section already walked. Stopping is the
        // only safe response; continuing would loop forever on untrusted input.
        if (visited.has(offset))
            break;
        visited.add(offset);
        // Sections are walked newest first, so an entry already present is the newer one.
        offset = await readSection(bytes, offset, map);
    }
    if (map.size === 0)
        throw new Error('xref: no objects were located');
    return map;
}
/** Returns the `/Prev` offset, or undefined at the end of the chain. */
async function readSection(bytes, offset, map) {
    const window = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + WINDOW)));
    // startxref is not always exact; the writer tolerates the same slippage.
    const start = /^\s*(xref\b|<<|\d+\s+\d+\s+obj)/.test(window)
        ? 0
        : (/\bxref\b|\d+\s+\d+\s+obj/.exec(window.slice(0, 512))?.index ?? -1);
    if (start < 0)
        throw new Error(`xref: nothing recognisable at ${offset}`);
    const text = window.slice(start);
    return /^\s*xref\b/.test(text)
        ? readTable(text, offset + start, map)
        : await readStream(bytes, offset + start, map);
}
function readTable(text, base, map) {
    const trailerAt = text.indexOf('trailer');
    if (trailerAt < 0)
        throw new Error('xref: table has no trailer');
    // Subsections: "first count" then `count` twenty-byte entries.
    const body = text.slice(0, trailerAt);
    const subsection = /(\d+)\s+(\d+)\s*[\r\n]+/g;
    let match = subsection.exec(body);
    while (match) {
        let first = Number(match[1]);
        let cursor = subsection.lastIndex;
        const count = Number(match[2]);
        for (let i = 0; i < count; i++) {
            const entry = /^(\d{10})\s(\d{5})\s([nf])\s?\s?/.exec(body.slice(cursor, cursor + 20));
            if (!entry)
                break;
            if (entry[3] === 'n' && !map.has(first)) {
                map.set(first, { offset: Number(entry[1]), generation: Number(entry[2]) });
            }
            first++;
            cursor += 20;
        }
        subsection.lastIndex = cursor;
        match = subsection.exec(body);
    }
    const trailer = parseDictionaryAt(text, text.indexOf('<<', trailerAt));
    void base;
    return numberOf(trailer.Prev);
}
/**
 * A cross-reference stream: the table itself is an object, Flate-compressed, whose
 * `/W` gives the width of each field and `/Index` the object numbers covered.
 */
async function readStream(bytes, offset, map) {
    const window = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + WINDOW)));
    const dictionaryAt = window.indexOf('<<');
    if (dictionaryAt < 0)
        throw new Error(`xref: no stream dictionary at ${offset}`);
    const dictionary = parseDictionaryAt(window, dictionaryAt);
    const data = await streamBytes(bytes, offset, window, dictionary);
    const widths = dictionary.W?.map(Number);
    if (!widths || widths.length < 3)
        throw new Error('xref: stream has no /W');
    const size = numberOf(dictionary.Size) ?? 0;
    const index = dictionary.Index?.map(Number) ?? [0, size];
    const rowWidth = widths.reduce((a, b) => a + b, 0);
    if (rowWidth === 0)
        throw new Error('xref: stream rows have zero width');
    let row = 0;
    for (let pair = 0; pair + 1 < index.length; pair += 2) {
        let number = index[pair];
        for (let i = 0; i < index[pair + 1]; i++, number++, row++) {
            const at = row * rowWidth;
            if (at + rowWidth > data.length)
                break;
            let cursor = at;
            const field = (width, fallback) => {
                if (width === 0)
                    return fallback;
                let value = 0;
                for (let b = 0; b < width; b++)
                    value = value * 256 + data[cursor++];
                return value;
            };
            const type = field(widths[0], 1); // /W [0 …] means "type 1 throughout"
            const second = field(widths[1], 0);
            const third = field(widths[2], 0);
            if (map.has(number))
                continue; // a newer section already claimed it
            if (type === 1)
                map.set(number, { offset: second, generation: third });
            else if (type === 2)
                map.set(number, { inObjectStream: second, index: third });
            // type 0 is a free object and is deliberately not recorded.
        }
    }
    return numberOf(dictionary.Prev);
}
/** The raw bytes of a stream object, decompressed when `/Filter` says so. */
export async function streamBytes(bytes, offset, window, dictionary) {
    const keyword = window.indexOf('stream');
    if (keyword < 0)
        throw new Error('xref: object is not a stream');
    // "stream" is followed by CRLF or LF, and nothing else.
    let start = offset + keyword + 'stream'.length;
    if (bytes[start] === 0x0d)
        start++;
    if (bytes[start] === 0x0a)
        start++;
    const length = numberOf(dictionary.Length);
    const end = length !== undefined ? start + length : findEndstream(bytes, start);
    const raw = bytes.subarray(start, Math.min(end, bytes.length));
    const filter = dictionary.Filter;
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
    const names = filters.map((f) => asName(f) ?? '');
    if (names.length === 0)
        return raw;
    if (!names.every((n) => n === 'FlateDecode')) {
        throw new Error(`xref: unsupported stream filter ${names.join(',') || 'unknown'}`);
    }
    const inflated = await inflate(raw);
    const params = dictionary.DecodeParms;
    const predictor = numberOf(entryOf(params ?? null, 'Predictor') ?? undefined) ?? 1;
    if (predictor <= 1)
        return inflated;
    return undoPredictor(inflated, predictor, numberOf(entryOf(params ?? null, 'Columns') ?? undefined) ?? 1, numberOf(entryOf(params ?? null, 'Colors') ?? undefined) ?? 1, numberOf(entryOf(params ?? null, 'BitsPerComponent') ?? undefined) ?? 8);
}
function findEndstream(bytes, start) {
    const text = decoder.decode(bytes.subarray(start, Math.min(bytes.length, start + (1 << 22))));
    const at = text.indexOf('endstream');
    return at < 0 ? bytes.length : start + at;
}
function findStartXref(bytes) {
    const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
    const pattern = /startxref\s+(\d+)/g;
    let offset;
    for (let found = pattern.exec(tail); found; found = pattern.exec(tail))
        offset = Number(found[1]);
    if (offset === undefined)
        throw new Error('xref: no startxref');
    if (offset <= 0 || offset >= bytes.length)
        throw new Error(`xref: startxref ${offset} out of range`);
    return offset;
}
const numberOf = (value) => typeof value === 'number' ? value : undefined;
//# sourceMappingURL=xref.js.map