import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { PdfViewer } from '../dist/view/viewer.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const bytes = (name = 'hello_world.pdf') => new Uint8Array(readFileSync(`${CORPUS}${name}`));
const PHONE = { width: 390, height: 700 };
/**
 * The viewer must delegate to the page API, never reimplement it.
 *
 * Two code paths producing annotations would drift, and the resulting bug would appear
 * through only one of them — which is the worst kind to chase. Byte identity is the only
 * check strong enough to notice.
 */
describe('the viewer delegates rather than reimplementing', () => {
    const cases = [
        ['a note',
            (page) => page.addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'hello', { red: 255, green: 235, blue: 59 }),
            (viewer) => viewer.addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'hello', { red: 255, green: 235, blue: 59 })],
        ['ink',
            (page) => page.addInk([[{ x: 10, y: 10 }, { x: 50, y: 50 }], [{ x: 20, y: 80 }, { x: 70, y: 80 }]], { red: 0, green: 90, blue: 220 }, 3),
            (viewer) => viewer.addInk([[{ x: 10, y: 10 }, { x: 50, y: 50 }], [{ x: 20, y: 80 }, { x: 70, y: 80 }]], { red: 0, green: 90, blue: 220 }, 3)],
        ['a highlight',
            (page) => page.addHighlight([{ p1: { x: 10, y: 20 }, p2: { x: 30, y: 20 },
                    p3: { x: 10, y: 10 }, p4: { x: 30, y: 10 } }], { red: 255, green: 255, blue: 0, alpha: 128 }),
            (viewer) => viewer.addHighlight([{ p1: { x: 10, y: 20 }, p2: { x: 30, y: 20 },
                    p3: { x: 10, y: 10 }, p4: { x: 30, y: 10 } }], { red: 255, green: 255, blue: 0, alpha: 128 })],
    ];
    for (const [name, viaPage, viaViewer] of cases) {
        test(`${name} produces identical bytes either way`, async () => {
            const a = await PdfDocument.open(bytes());
            await viaPage(await a.page(0));
            const b = await PdfDocument.open(bytes());
            await viaViewer(await PdfViewer.open(b, PHONE, { throttleMs: 0 }));
            assert.deepEqual(await a.toBytes('full'), await b.toBytes('full'), `${name}: the viewer has diverged from the page API`);
        });
    }
    test('a field value produces identical bytes either way', async () => {
        const a = await PdfDocument.open(bytes('text_form.pdf'));
        await (await a.page(0)).setText('typed', 0);
        const b = await PdfDocument.open(bytes('text_form.pdf'));
        await (await PdfViewer.open(b, PHONE, { throttleMs: 0 })).setFieldText('typed', 0);
        assert.deepEqual(await a.toBytes('full'), await b.toBytes('full'));
    });
    test('redaction produces identical bytes either way', async () => {
        const a = await PdfDocument.open(bytes());
        const target = (await (await a.page(0)).objects()).find((o) => o.text?.includes('Goodbye'));
        await a.redact([{ kind: 'region', rect: target.bounds, pageIndex: 0 }]);
        const b = await PdfDocument.open(bytes());
        await (await PdfViewer.open(b, PHONE, { throttleMs: 0 }))
            .redact([{ kind: 'region', rect: target.bounds, pageIndex: 0 }]);
        assert.deepEqual(await a.toBytes('full'), await b.toBytes('full'));
    });
});
//# sourceMappingURL=viewer-delegation.test.js.map