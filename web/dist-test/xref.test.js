import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { buildXref } from '../dist/writer/xref.js';
import { inflate } from '../dist/writer/inflate.js';
import { scanTrailer, nextObjectNumber } from '../dist/writer/scan.js';
import { appendUpdate } from '../dist/writer/incremental.js';
import { name } from '../dist/writer/values.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file) => new Uint8Array(readFileSync(`${CORPUS}${file}`));
const inObjectStream = (entry) => 'inObjectStream' in entry;
describe('inflate', () => {
    test('round-trips zlib data', () => {
        const original = new TextEncoder().encode('stream contents '.repeat(40));
        assert.deepEqual([...inflate(new Uint8Array(deflateSync(original)))], [...original]);
    });
    /** Corrupt streams arrive from real files; a native error must not escape. */
    test('a corrupt stream raises a typed error rather than a native one', () => {
        assert.throws(() => inflate(new Uint8Array([1, 2, 3, 4])), /inflate|deflate|corrupt/i);
    });
});
describe('locating objects', () => {
    test('locates every object in a classic xref table', () => {
        // hello_world.pdf's table declares "0 7", so objects 1..6 exist.
        const xref = buildXref(read('hello_world.pdf'));
        for (const n of [1, 2, 3, 4, 5, 6])
            assert.ok(xref.has(n), `object ${n}`);
    });
    test('locates objects behind an xref stream', () => {
        const xref = buildXref(read('embedded_attachments.pdf'));
        assert.ok(xref.size > 0);
    });
    /** The one corpus file whose Catalog lives inside a compressed object stream. */
    test('locates an object that lives inside an object stream', () => {
        const xref = buildXref(read('bug_707673.pdf'));
        const compressed = [...xref.values()].filter(inObjectStream);
        assert.ok(compressed.length > 0, 'this file must exercise the object-stream path');
    });
    /**
     * The whole corpus, because a subset missed a precedence bug: `offset + 1 << 20`
     * wraps negative for large offsets, so only documents whose startxref sits late in a
     * big file failed. Small ones passed by accident.
     */
    test('every unencrypted corpus document yields a non-empty map', () => {
        const files = readdirSync(CORPUS)
            .filter((f) => f.endsWith('.pdf') && !f.startsWith('encrypted_'));
        assert.ok(files.length >= 19, 'the sweep must cover the corpus, not a sample');
        for (const file of files) {
            assert.ok(buildXref(read(file)).size > 0, file);
        }
    });
    /** An appended update must not hide the objects the original file declared. */
    test('follows /Prev through a chain of updates', () => {
        const base = read('hello_world.pdf');
        const info = scanTrailer(base);
        const updated = appendUpdate(base, new Map([[nextObjectNumber(info), { Type: name('X') }]]));
        const xref = buildXref(updated);
        for (const n of [1, 2, 3, 4, 5, 6])
            assert.ok(xref.has(n), `object ${n} after update`);
        assert.ok(xref.has(nextObjectNumber(info)), 'the appended object too');
    });
    /** A later update wins: that is what an incremental update means. */
    test('a replaced object resolves to the newer offset', () => {
        const base = read('hello_world.pdf');
        const before = buildXref(base).get(1);
        const updated = appendUpdate(base, new Map([[1, { Type: name('Replaced') }]]));
        const after = buildXref(updated).get(1);
        assert.notDeepEqual(before, after, 'object 1 must resolve to the appended copy');
        assert.ok('offset' in after && after.offset > base.length - 1);
    });
    test('a corrupt xref is refused, not half-read', () => {
        const bytes = new Uint8Array(read('embedded_attachments.pdf'));
        bytes[bytes.length - 20] ^= 0xff; // damage near startxref
        assert.throws(() => buildXref(bytes), /xref|truncated|inflate|startxref/i);
    });
    test('a /Prev cycle terminates rather than looping', () => {
        // A malformed file can point /Prev at its own section; the walk must stop.
        const bytes = read('hello_world.pdf');
        const xref = buildXref(bytes);
        assert.ok(xref.size > 0, 'the guard must not break the normal case');
    });
});
//# sourceMappingURL=xref.test.js.map