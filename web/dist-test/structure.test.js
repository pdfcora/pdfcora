import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PdfDocument, PdfError } from '../dist/index.js';
import { appendUpdate } from '../dist/writer/incremental.js';
import { findFigures } from '../dist/writer/structure.js';
import { raw } from '../dist/writer/values.js';
const EXPECTED = JSON.parse(readFileSync(new URL('../../conformance/alt-text/tagged-expected.json', import.meta.url), 'utf8'));
const tagged = () => new Uint8Array(readFileSync(new URL('../../conformance/alt-text/tagged.pdf', import.meta.url)));
const corpus = (name) => new Uint8Array(readFileSync(new URL(`../../conformance/corpus/${name}`, import.meta.url)));
const flatten = (elements) => elements.flatMap((e) => [e, ...flatten(e.children)]);
const figures = async (document, pageIndex) => flatten(await (await document.page(pageIndex)).structure()).filter((e) => e.type === 'Figure');
const EDITS = [
    { pageIndex: 0, markedContentIds: [4], altText: 'A photo of an office building at dusk' },
    { pageIndex: 0, markedContentIds: [6], decorative: true },
    { pageIndex: 1, markedContentIds: [2], altText: 'Company logo: a red circle (é)' },
];
describe('structure tree', () => {
    test('reads the tagged test document with types, ids, alt text and bounds', async () => {
        const document = await PdfDocument.open(tagged());
        assert.equal(await document.isTagged(), true);
        const roots = await (await document.page(0)).structure();
        assert.deepEqual(roots.map((r) => r.type), ['Document']);
        assert.deepEqual(roots[0].children.map((c) => c.type), ['H1', 'P', 'Figure', 'P', 'Figure', 'P', 'Figure', 'P']);
        assert.deepEqual(roots[0].children.map((c) => c.markedContentIds), [[0], [1], [2], [3], [4], [5], [6], [7]]);
        const [chart, photo, rule] = await figures(document, 0);
        assert.equal(chart.altText, EXPECTED.figuresWithAlt[0].altText);
        assert.equal(photo.altText, undefined);
        assert.deepEqual(photo.bounds, { left: 72, bottom: 300, right: 288, top: 444 });
        assert.ok(Math.abs(rule.bounds.top - rule.bounds.bottom - 2) < 0.01);
        const [logo] = await figures(document, 1);
        assert.deepEqual(logo.markedContentIds, [2]);
        await document.close();
    });
    test('an untagged document has no structure', async () => {
        const document = await PdfDocument.open(corpus('hello_world.pdf'));
        assert.equal(await document.isTagged(), false);
        assert.deepEqual(await (await document.page(0)).structure(), []);
    });
});
describe('writing figures', () => {
    test('descriptions and decorative marking land in a new document; the original is unchanged', async () => {
        const document = await PdfDocument.open(tagged());
        const updated = await document.updateFigures(EDITS);
        const page0 = await figures(updated, 0);
        assert.deepEqual(page0.map((f) => f.altText), [EXPECTED.figuresWithAlt[0].altText, EDITS[0].altText]);
        assert.equal((await figures(updated, 1))[0].altText, EDITS[2].altText);
        assert.equal((await figures(document, 0)).length, 3, 'the original keeps every figure');
        const bytes = await updated.toBytes('full');
        mkdirSync(new URL('../../build/alt-text/', import.meta.url), { recursive: true });
        writeFileSync(new URL('../../build/alt-text/written-web.pdf', import.meta.url), bytes);
    });
    test('description-only edits are an incremental update of the original bytes', async () => {
        const original = tagged();
        const document = await PdfDocument.open(original);
        const updated = await document.updateFigures([EDITS[0]]);
        const bytes = await updated.toBytes('incremental');
        assert.deepEqual(bytes.subarray(0, original.length), original);
    });
    test('a figure inside an object stream of a signed file is rewritten and the signature still verifies', async () => {
        const document = await PdfDocument.open(corpus('signed_unh_iol.pdf'));
        const updated = await document.updateFigures([{ pageIndex: 0, markedContentIds: [27], altText: 'UNH-IOL logo' }]);
        assert.equal((await figures(updated, 0))[0].altText, 'UNH-IOL logo');
        const [signature] = await updated.signatures();
        assert.equal((await updated.verify(signature)).kind, 'untrusted', 'intact, from an unknown issuer');
    });
    test('an edit naming no figure, or a non-figure, writes nothing', async () => {
        const document = await PdfDocument.open(tagged());
        for (const edit of [{ pageIndex: 0, markedContentIds: [99], altText: 'x' }, { pageIndex: 0, markedContentIds: [1], altText: 'x' }]) {
            await assert.rejects(document.updateFigures([EDITS[0], edit]), (e) => e instanceof PdfError && e.code === 'invalidOperation');
        }
        await assert.rejects(document.updateFigures([{ ...EDITS[0], pageIndex: 5 }]), (e) => e instanceof PdfError && e.code === 'pageOutOfRange');
    });
    test('a figure rewritten twice keeps its strings and is found through an appended update', async () => {
        // A title with escapes and a hex language tag must survive the element being rewritten.
        const base = tagged();
        const text = new TextDecoder('latin1').decode(base);
        const photo = /(\d+) 0 obj\n<< \/Type \/StructElem \/S \/Figure [^\n]*\/K 4 >>/.exec(text);
        const rewritten = appendUpdate(base, new Map([[Number(photo[1]), raw(new TextEncoder().encode(photo[0].slice(photo[0].indexOf('<<')).replace('/K 4', '/K 4 /T (a \\(b\\)) /Lang <656E>')))]]));
        assert.equal((await findFigures(rewritten, [EDITS[0]])).length, 1);
        const updated = await (await PdfDocument.open(rewritten)).updateFigures([EDITS[0]]);
        const photoFigure = (await figures(updated, 0))[1];
        assert.equal(photoFigure.title, 'a (b)');
        assert.equal(photoFigure.language, 'en');
        assert.equal(photoFigure.altText, EDITS[0].altText);
    });
});
//# sourceMappingURL=structure.test.js.map