import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanTrailer, nextObjectNumber } from '../dist/writer/scan.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file) => new Uint8Array(readFileSync(join(CORPUS, file)));
// Encrypted documents are refused by design; they have their own test below.
const documents = readdirSync(CORPUS)
    .filter((f) => f.endsWith('.pdf') && !f.startsWith('encrypted_'));
describe('trailer scanning', () => {
    test('every corpus document scans, whichever xref style it uses', () => {
        const styles = new Set();
        for (const file of documents) {
            const bytes = read(file);
            const info = scanTrailer(bytes);
            assert.ok(info.startXref > 0 && info.startXref < bytes.length, `${file}: startXref`);
            assert.ok(info.size > 0, `${file}: /Size`);
            assert.ok(info.root, `${file}: every PDF has a /Root`);
            styles.add(info.style);
        }
        // A test that only ever saw one style would not prove much.
        assert.deepEqual([...styles].sort(), ['stream', 'table']);
    });
    test('reports the style each document actually uses', () => {
        assert.equal(scanTrailer(read('hello_world.pdf')).style, 'table');
        assert.equal(scanTrailer(read('embedded_attachments.pdf')).style, 'stream');
    });
    /**
     * Appending to an encrypted document would require encrypting the strings in the
     * new objects with the document's key, which this writer does not do. Refusing is
     * the only honest option: a silently unencrypted string corrupts the file.
     */
    test('refuses an encrypted document rather than producing a broken update', () => {
        assert.throws(() => scanTrailer(read('encrypted_hello_world_r2.pdf')), /encrypted/i);
    });
    /**
     * bug_455199.pdf declares /Size 6 while its table lists objects 0-6, and its
     * startxref points eight bytes before the xref keyword. Trusting either one
     * overwrites object 6 — the page content stream — and the text silently vanishes.
     */
    test('does not trust /Size or an exact startxref', () => {
        const info = scanTrailer(read('bug_455199.pdf'));
        assert.equal(info.style, 'table', 'startxref points early; the style is still a table');
        assert.ok(nextObjectNumber(info) > 6, 'must not reuse a live object number');
    });
    test('rejects bytes that are not a PDF', () => {
        assert.throws(() => scanTrailer(new Uint8Array([1, 2, 3])), /startxref|not a pdf/i);
    });
});
//# sourceMappingURL=writer-scan.test.js.map