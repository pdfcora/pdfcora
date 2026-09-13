import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file) => new Uint8Array(readFileSync(`${CORPUS}${file}`));
const asText = (bytes) => new TextDecoder('latin1').decode(bytes);
describe('redacting by search', () => {
    test('every occurrence of the query is removed', async () => {
        const document = await PdfDocument.open(read('hello_world.pdf'));
        const report = await document.redact([{ kind: 'textMatches', query: 'world' }]);
        const saved = await document.toBytes('full');
        const text = await (await (await PdfDocument.open(saved)).page(0)).text.string();
        // "world" appears in both objects, so both must lose it.
        assert.ok(!text.includes('world'), `still present: ${JSON.stringify(text)}`);
        assert.ok(!asText(saved).includes('world'), 'still in the file bytes');
        assert.ok(report.pages.includes(0));
    });
    test('text around the match survives', async () => {
        const document = await PdfDocument.open(read('hello_world.pdf'));
        await document.redact([{ kind: 'textMatches', query: 'Goodbye' }]);
        const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
            .text.string();
        assert.ok(!text.includes('Goodbye'));
        assert.ok(text.includes('Hello'), `unrelated text was lost: ${JSON.stringify(text)}`);
    });
    test('a query that matches nothing changes nothing', async () => {
        const document = await PdfDocument.open(read('hello_world.pdf'));
        const report = await document.redact([{ kind: 'textMatches', query: 'zzzzz' }]);
        assert.equal(report.textObjects + report.textObjectsSplit, 0);
        const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
            .text.string();
        assert.ok(text.includes('Hello') && text.includes('Goodbye'));
    });
    test('a match spanning more than one page is handled on each', async () => {
        const document = await PdfDocument.open(read('hello_world_2_pages_split_streams.pdf'));
        const pages = await document.pageCount();
        assert.ok(pages > 1);
        await document.redact([{ kind: 'textMatches', query: 'Hello' }]);
        const saved = await document.toBytes('full');
        const reopened = await PdfDocument.open(saved);
        for (let i = 0; i < pages; i++) {
            const text = await (await reopened.page(i)).text.string();
            assert.ok(!text.includes('Hello'), `page ${i}: ${JSON.stringify(text)}`);
        }
    });
});
//# sourceMappingURL=redact-search.test.js.map