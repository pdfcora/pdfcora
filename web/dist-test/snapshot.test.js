import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { configureLicenseForTesting } from '../dist/license/state.js';
const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));
const read = (name) => new Uint8Array(readFileSync(new URL(`../../conformance/corpus/${name}`, import.meta.url)));
test('a snapshot reopens the document as it was, edits included', async () => {
    const document = await PdfDocument.open(read('hello_world.pdf'));
    await (await document.page(0)).addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'kept');
    const snapshot = await document.snapshot();
    await document.redact([{ kind: 'textMatches', query: 'Hello' }]);
    const copy = await snapshot.open();
    assert.ok((await (await copy.page(0)).text.string()).includes('Hello'));
    assert.equal((await (await copy.page(0)).annotations()).length, 1);
    assert.equal(Object.keys(snapshot).length, 0, 'a snapshot exposes no fields');
});
test('a snapshot of a watermarked document reopens watermarked, and stamps once', async () => {
    await configureLicenseForTesting({ key: null, host: null });
    try {
        const document = await PdfDocument.open(read('hello_world.pdf'));
        const copy = await (await document.snapshot()).open();
        assert.equal(copy.needsWatermark, true);
        const saved = await PdfDocument.open(await copy.toBytes());
        const text = await (await saved.page(0)).text.string();
        assert.equal(text.split('PdfiumKit trial').length - 1, 1);
    }
    finally {
        await configureLicenseForTesting({ key: FIXTURE.fullKey, host: null });
    }
});
//# sourceMappingURL=snapshot.test.js.map