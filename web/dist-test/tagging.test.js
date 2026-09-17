import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PdfDocument, PdfError } from '../dist/index.js';
import { configureLicenseForTesting } from '../dist/license/state.js';
const LICENSE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));
const EXPECTED = JSON.parse(readFileSync(new URL('../../conformance/remediation/untagged-expected.json', import.meta.url), 'utf8'));
const untagged = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('../../conformance/remediation/untagged.pdf', import.meta.url))));
/** The expected blocks, with object indices counted in order per page. */
function expectedBlocks() {
    const next = new Map();
    return EXPECTED.map((b) => {
        const start = next.get(b.pageIndex) ?? 0;
        next.set(b.pageIndex, start + b.objectCount);
        return { pageIndex: b.pageIndex, type: b.type, objectIndices: Array.from({ length: b.objectCount }, (_, i) => start + i) };
    });
}
const shape = (elements) => elements.map((e) => (e.children.length ? { [e.type]: shape(e.children) } : e.type));
const invalid = (e) => e instanceof PdfError && e.code === 'invalidOperation';
describe('tagging content', () => {
    test('writes the structure tree, lists included, into a new document', async () => {
        const document = await untagged();
        const tagged = await document.tagContent(expectedBlocks(), { title: 'Quarterly newsletter', language: 'en-GB' });
        assert.equal(await tagged.isTagged(), true);
        assert.equal(await document.isTagged(), false, 'the original is unchanged');
        assert.deepEqual(shape(await (await tagged.page(0)).structure()), [{ Document: [
                    'H1', 'P', 'H2', { L: [{ LI: ['LBody'] }, { LI: ['LBody'] }, { LI: ['LBody'] }] }, 'P', 'Figure', 'P',
                ] }]);
        assert.deepEqual(shape(await (await tagged.page(1)).structure()), [{ Document: [
                    'H2', { L: [{ LI: ['LBody'] }, { LI: ['LBody'] }] }, 'P',
                ] }]);
        const paragraph = (await (await tagged.page(0)).structure())[0].children[1];
        assert.deepEqual(paragraph.markedContentIds, [1, 2], 'one id per object');
        // Once the figure is described, the document is what PDF/UA-1 asks for.
        const described = await tagged.updateFigures([{ pageIndex: 0, markedContentIds: [8], altText: 'The Berlin office at dusk' }]);
        mkdirSync(new URL('../../build/remediation/', import.meta.url), { recursive: true });
        writeFileSync(new URL('../../build/remediation/written-web.pdf', import.meta.url), await described.toBytes());
    });
    test('a figure can be described while tagging', async () => {
        const blocks = expectedBlocks().map((b) => (b.type === 'Figure' ? { ...b, altText: 'The Berlin office' } : b));
        const tagged = await (await untagged()).tagContent(blocks, { title: 'T', language: 'en' });
        const figure = (await (await tagged.page(0)).structure())[0].children.find((c) => c.type === 'Figure');
        assert.equal(figure.altText, 'The Berlin office');
    });
    test('refuses what it cannot write, writing nothing', async () => {
        const document = await untagged();
        const blocks = expectedBlocks();
        const options = { title: 'T', language: 'en' };
        await assert.rejects(document.tagContent([...blocks, { pageIndex: 0, type: 'P', objectIndices: [0] }], options), invalid);
        await assert.rejects(document.tagContent([{ pageIndex: 0, type: 'P', objectIndices: [99] }], options), invalid);
        await assert.rejects(document.tagContent([{ pageIndex: 0, type: 'P', objectIndices: [0], altText: 'x' }], options), invalid);
        await assert.rejects(document.tagContent(blocks, { language: 'en' }), invalid, 'no title');
        await assert.rejects(document.tagContent(blocks, { title: 'T' }), invalid, 'no language');
        await assert.rejects(document.tagContent([{ pageIndex: 7, type: 'P', objectIndices: [0] }], options), (e) => e instanceof PdfError && e.code === 'pageOutOfRange');
        const tagged = await document.tagContent(blocks, options);
        await assert.rejects(tagged.tagContent(blocks, options), invalid, 'already tagged');
    });
    test('a trial document writes a watermarked result that stamps once', async () => {
        await configureLicenseForTesting({ key: null, host: null });
        try {
            const tagged = await (await untagged()).tagContent(expectedBlocks(), { title: 'T', language: 'en' });
            assert.equal(tagged.needsWatermark, true);
            const described = await tagged.updateFigures([
                { pageIndex: 0, markedContentIds: [8], altText: 'The Berlin office at dusk' }
            ]);
            const bytes = await described.toBytes();
            const saved = await PdfDocument.open(bytes);
            assert.equal((await (await saved.page(0)).text.string()).split('PDFCora trial').length - 1, 1);
            // Checked by veraPDF in CI: the watermark must be an artifact, or it is untagged
            // content on every page (7.1-3). Its standard font is never embedded, so 7.21.4.1
            // is allowed there and nothing else is.
            mkdirSync(new URL('../../build/remediation/', import.meta.url), { recursive: true });
            writeFileSync(new URL('../../build/remediation/written-web-trial.pdf', import.meta.url), bytes);
        }
        finally {
            await configureLicenseForTesting({ key: LICENSE.fullKey, host: null });
        }
    });
});
//# sourceMappingURL=tagging.test.js.map