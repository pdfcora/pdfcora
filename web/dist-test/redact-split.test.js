import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file) => new Uint8Array(readFileSync(`${CORPUS}${file}`));
const asText = (bytes) => new TextDecoder('latin1').decode(bytes);
/**
 * `hello_world.pdf`'s second object is "Goodbye, world!" at l=20.8 r=135.0, b=96.6
 * t=111.8 in 16pt Helvetica — all measured from the engine.
 */
async function openGoodbye() {
    const document = await PdfDocument.open(read('hello_world.pdf'));
    const run = (await (await document.page(0)).objects())
        .find((o) => o.text === 'Goodbye, world!');
    return { document, run };
}
describe('splitting a partially covered run', () => {
    test('a region over part of a run removes only those characters', async () => {
        const { document, run } = await openGoodbye();
        // Cover the first word: "Goodbye," ends well before halfway across the run.
        const region = { ...run.bounds, right: run.bounds.left + 62 };
        const report = await document.redact([{ kind: 'region', rect: region, pageIndex: 0 }]);
        const saved = await document.toBytes('full');
        const text = await (await (await PdfDocument.open(saved)).page(0)).text.string();
        assert.ok(!text.includes('Goodbye'), `covered word survived: ${JSON.stringify(text)}`);
        assert.ok(text.includes('world'), `uncovered text was lost: ${JSON.stringify(text)}`);
        assert.ok(!asText(saved).includes('Goodbye'), 'the covered word is still in the bytes');
        assert.equal(report.textObjectsSplit, 1);
        assert.equal(report.textObjects, 0, 'the run was split, not removed outright');
    });
    /** A character half inside the region is still legible, so it goes. */
    test('characters are dropped on intersection, not containment', async () => {
        const { document, run } = await openGoodbye();
        // 'G' spans l=20.8 onward; cover only its left half.
        const region = { ...run.bounds, right: run.bounds.left + 4 };
        await document.redact([{ kind: 'region', rect: region, pageIndex: 0 }]);
        const text = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
            .text.string();
        assert.ok(!text.includes('Goodbye'), 'a half-covered character must still be removed');
        assert.ok(text.includes('oodbye'), `the rest of the word should remain: ${JSON.stringify(text)}`);
    });
    test('the surviving text keeps its font size', async () => {
        const { document, run } = await openGoodbye();
        assert.equal(run.fontSize, 16);
        await document.redact([
            { kind: 'region', rect: { ...run.bounds, right: run.bounds.left + 62 }, pageIndex: 0 },
        ]);
        const objects = await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
            .objects();
        const survivor = objects.find((o) => o.text?.includes('world') && !o.text.includes('Hello'));
        assert.ok(survivor, 'the surviving run must still be a text object');
        assert.equal(survivor.fontSize, 16, 'a split that loses the size reflows the page');
    });
    /** The survivor must render where it was, not shifted to the object's old origin. */
    test('the surviving run keeps its position', async () => {
        const { document, run } = await openGoodbye();
        const objects = await (await document.page(0)).objects();
        const before = objects.find((o) => o.text === 'Goodbye, world!');
        await document.redact([
            { kind: 'region', rect: { ...run.bounds, right: run.bounds.left + 62 }, pageIndex: 0 },
        ]);
        const after = (await (await (await PdfDocument.open(await document.toBytes('full'))).page(0))
            .objects()).find((o) => o.text?.includes('world') && !o.text.includes('Hello'));
        // It starts to the right of where the original did, since the first word went.
        assert.ok(after.bounds.left > before.bounds.left, `survivor at ${after.bounds.left}, original at ${before.bounds.left}`);
        assert.ok(Math.abs(after.bounds.bottom - before.bounds.bottom) < 2, 'the baseline must not move');
    });
    test('a region covering the whole run removes it outright', async () => {
        const { document, run } = await openGoodbye();
        const report = await document.redact([{ kind: 'region', rect: run.bounds, pageIndex: 0 }]);
        assert.equal(report.textObjects, 1, 'fully covered is a removal, not a split');
        assert.equal(report.textObjectsSplit, 0);
    });
    test('a region covering nothing splits nothing', async () => {
        const { document } = await openGoodbye();
        const report = await document.redact([
            { kind: 'region', rect: { left: 0, bottom: 0, right: 3, top: 3 }, pageIndex: 0 },
        ]);
        assert.equal(report.textObjectsSplit, 0);
        assert.equal(report.textObjects, 0);
    });
});
//# sourceMappingURL=redact-split.test.js.map