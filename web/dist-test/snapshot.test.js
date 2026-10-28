import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
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
//# sourceMappingURL=snapshot.test.js.map