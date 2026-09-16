/**
 * Reading just enough of an existing PDF to append to it.
 *
 * This is deliberately not a PDF parser. To write an incremental update we need four
 * things — where the last cross-reference section starts, which style it uses, the
 * next free object number, and the trailer entries to carry forward — and nothing else.
 */
import { parseDictionaryAt } from './dictionary.js';
const decoder = new TextDecoder('latin1');
export function scanTrailer(bytes) {
    const startXref = findStartXref(bytes);
    const dictionary = readDictionaryAt(bytes, startXref);
    if ('Encrypt' in dictionary) {
        // Strings in appended objects would have to be encrypted with the document key.
        // Writing them in the clear produces a file that opens and then shows mojibake,
        // which is worse than refusing.
        throw new Error('cannot append to an encrypted document');
    }
    const size = numberOf(dictionary.Size);
    if (size === undefined)
        throw new Error('trailer has no /Size');
    if (!dictionary.Root)
        throw new Error('trailer has no /Root');
    return {
        startXref,
        style: dictionary[STYLE],
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
export function nextObjectNumber(info) {
    return Math.max(info.size, info.highestObject + 1);
}
/** Scans for `N G obj` headers, which is the only account of object numbers that
 *  cannot disagree with itself. Objects inside object streams are not visible here,
 *  which is why /Size still participates in the maximum. */
function highestObjectNumber(bytes, size) {
    const text = decoder.decode(bytes);
    let highest = size - 1;
    const header = /(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b/g;
    for (let m = header.exec(text); m; m = header.exec(text)) {
        const n = plausible(m[1]);
        if (n !== undefined)
            highest = Math.max(highest, n);
    }
    const subsection = /\bxref\s*\n\s*(\d+)\s+(\d+)/g;
    for (let m = subsection.exec(text); m; m = subsection.exec(text)) {
        const first = plausible(m[1]);
        const count = plausible(m[2]);
        if (first !== undefined && count !== undefined)
            highest = Math.max(highest, first + count - 1);
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
function plausible(digits) {
    const value = Number(digits);
    return Number.isInteger(value) && value >= 0 && value <= MAX_OBJECT_NUMBER ? value : undefined;
}
const STYLE = '__style';
function findStartXref(bytes) {
    // The spec allows junk after %%EOF, so search backwards from the end.
    const tail = decoder.decode(bytes.subarray(Math.max(0, bytes.length - 2048)));
    const match = /startxref\s+(\d+)/g;
    let offset;
    for (let found = match.exec(tail); found; found = match.exec(tail)) {
        offset = Number(found[1]);
    }
    if (offset === undefined)
        throw new Error('no startxref: not a PDF, or truncated');
    if (offset <= 0 || offset >= bytes.length)
        throw new Error(`startxref ${offset} is out of range`);
    return offset;
}
/**
 * Reads the trailer dictionary at `offset`, which is either a classic `xref` section
 * followed by `trailer <<…>>`, or a cross-reference stream whose own dictionary holds
 * the same entries. The stream body is never decoded: /Size and /Root live in the
 * dictionary either way.
 */
function readDictionaryAt(bytes, offset) {
    let window = decoder.decode(bytes.subarray(offset, Math.min(bytes.length, offset + 65536)));
    // startxref is not always exact. bug_455199.pdf points eight bytes early, into the
    // preceding "endobj". PDFium tolerates it, so this must too.
    if (!/^\s*(xref\b|<<)/.test(window)) {
        const near = /\bxref\b|<</.exec(window.slice(0, 512));
        if (near)
            window = window.slice(near.index);
    }
    if (/^\s*xref\b/.test(window)) {
        const at = window.indexOf('trailer');
        if (at < 0)
            throw new Error('xref table has no trailer');
        const parsed = parseDictionaryAt(window, window.indexOf('<<', at));
        return { ...parsed, [STYLE]: 'table' };
    }
    const at = window.indexOf('<<');
    if (at < 0)
        throw new Error(`no dictionary at startxref ${offset}`);
    const parsed = parseDictionaryAt(window, at);
    return { ...parsed, [STYLE]: 'stream' };
}
function numberOf(value) {
    return typeof value === 'number' ? value : undefined;
}
//# sourceMappingURL=scan.js.map