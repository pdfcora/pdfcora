/**
 * Appending an incremental update.
 *
 * The original bytes are never touched: new and replaced objects are written after
 * them, followed by a cross-reference section listing only what changed and a trailer
 * whose /Prev points at the previous section. A reader that follows the chain sees the
 * new objects; the old file is still intact underneath, which is what lets an earlier
 * signature keep verifying.
 */
import { serialize, name, ref } from './values.js';
import { scanTrailer } from './scan.js';
const ascii = (value) => new TextEncoder().encode(value);
export function appendUpdate(base, objects, options = {}) {
    const info = scanTrailer(base);
    const parts = [];
    let offset = base.length;
    // A generating application may omit the final newline; without one the first
    // appended object would run into %%EOF.
    const needsNewline = base[base.length - 1] !== 0x0a && base[base.length - 1] !== 0x0d;
    if (needsNewline) {
        parts.push(ascii('\n'));
        offset += 1;
    }
    const positions = new Map();
    for (const [number, value] of [...objects].sort((a, b) => a[0] - b[0])) {
        positions.set(number, offset);
        const bytes = serialize(value, { objectNumber: number });
        parts.push(bytes);
        offset += bytes.length;
    }
    const highest = positions.size ? Math.max(...positions.keys()) : info.size - 1;
    const size = Math.max(info.size, highest + 1);
    const section = info.style === 'table'
        ? xrefTable(positions, size, info, offset, options.trailer)
        : xrefStream(positions, size, info, offset, options.trailer);
    parts.push(section);
    return concat([base, ...parts]);
}
function trailerEntries(size, info, extra) {
    const entries = { Size: size, Root: info.root, Prev: info.startXref };
    if (info.info)
        entries.Info = info.info;
    if (info.id)
        entries.ID = info.id;
    return { ...entries, ...extra };
}
/**
 * Classic cross-reference table. Entries must be grouped into runs of consecutive
 * object numbers, and each line is exactly 20 bytes.
 */
function xrefTable(positions, size, info, xrefOffset, extra) {
    const numbers = [...positions.keys()].sort((a, b) => a - b);
    let table = 'xref\n';
    for (let i = 0; i < numbers.length;) {
        let end = i + 1;
        while (end < numbers.length && numbers[end] === numbers[end - 1] + 1)
            end++;
        table += `${numbers[i]} ${end - i}\n`;
        for (let j = i; j < end; j++) {
            table += `${String(positions.get(numbers[j])).padStart(10, '0')} 00000 n \n`;
        }
        i = end;
    }
    const trailer = serialize(trailerEntries(size, info, extra));
    return concat([
        ascii(table),
        ascii('trailer\n'),
        trailer,
        ascii(`\nstartxref\n${xrefOffset}\n%%EOF\n`),
    ]);
}
/**
 * Cross-reference stream, for files written that way. The stream is its own object, so
 * it occupies a number and must appear in its own table. Fields are written uncompressed
 * — /Filter is omitted — because the saving is irrelevant for a handful of entries and
 * an undecodable stream is a much worse failure than a large one.
 */
function xrefStream(positions, size, info, xrefOffset, extra) {
    const streamNumber = size;
    const all = new Map(positions);
    all.set(streamNumber, xrefOffset);
    const numbers = [...all.keys()].sort((a, b) => a - b);
    const index = [];
    const rows = [];
    for (let i = 0; i < numbers.length;) {
        let end = i + 1;
        while (end < numbers.length && numbers[end] === numbers[end - 1] + 1)
            end++;
        index.push(numbers[i], end - i);
        for (let j = i; j < end; j++)
            rows.push([1, all.get(numbers[j]), 0]);
        i = end;
    }
    // /W [1 4 2]: type, a four-byte offset, a two-byte generation.
    const body = new Uint8Array(rows.length * 7);
    rows.forEach((row, i) => {
        const at = i * 7;
        body[at] = row[0];
        body[at + 1] = (row[1] >>> 24) & 0xff;
        body[at + 2] = (row[1] >>> 16) & 0xff;
        body[at + 3] = (row[1] >>> 8) & 0xff;
        body[at + 4] = row[1] & 0xff;
        body[at + 5] = (row[2] >> 8) & 0xff;
        body[at + 6] = row[2] & 0xff;
    });
    const dictionary = {
        ...trailerEntries(streamNumber + 1, info, extra),
        Type: name('XRef'),
        W: [1, 4, 2],
        Index: index,
        Length: body.length,
    };
    return concat([
        ascii(`${streamNumber} 0 obj\n`),
        serialize(dictionary),
        ascii('\nstream\n'),
        body,
        ascii('\nendstream\nendobj\n'),
        ascii(`startxref\n${xrefOffset}\n%%EOF\n`),
    ]);
}
function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
export { ref };
//# sourceMappingURL=incremental.js.map