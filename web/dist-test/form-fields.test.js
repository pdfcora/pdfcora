import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, PdfError } from '../dist/index.js';
import { readObject } from '../dist/writer/read.js';
const read = (path) => new Uint8Array(readFileSync(new URL(`../../conformance/${path}`, import.meta.url)));
const invalid = (e) => e instanceof PdfError && e.code === 'invalidOperation';
const FIELDS = [
    { pageIndex: 0, kind: 'text', rect: { left: 179.5, bottom: 621.5, right: 500.5, top: 642.5 }, name: 'Email', tooltip: 'Email' },
    { pageIndex: 0, kind: 'checkBox', rect: { left: 71.5, bottom: 517.5, right: 84.5, top: 530.5 }, name: 'I agree to the terms' },
];
describe('adding form fields', () => {
    test('created fields are listed, fill, and keep their values through save and reopen', async () => {
        const document = await PdfDocument.open(read('forms/flat.pdf'));
        const withFields = await document.addFormFields(FIELDS);
        assert.equal((await (await document.page(0)).formFields()).length, 0, 'the original is unchanged');
        const page = await withFields.page(0);
        const fields = await page.formFields();
        assert.deepEqual(fields.map((f) => [f.kind, f.name, f.alternateName]), [
            ['text', 'Email', 'Email'], ['checkBox', 'I agree to the terms', undefined],
        ]);
        assert.deepEqual(fields[0].rect, FIELDS[0].rect);
        await page.setText('anna@example.com', fields[0].annotationIndex);
        await page.setChecked(true, fields[1].annotationIndex);
        const reopened = await PdfDocument.open(await withFields.toBytes('full'));
        const after = await (await reopened.page(0)).formFields();
        assert.equal(after[0].kind === 'text' && after[0].value, 'anna@example.com');
        assert.equal(after[1].kind === 'checkBox' && after[1].isChecked, true);
    });
    test('existing fields and annotations are kept; names must be new and non-empty', async () => {
        const document = await PdfDocument.open(read('corpus/text_form.pdf'));
        const [existing] = await (await document.page(0)).formFields();
        const withFields = await document.addFormFields([{ ...FIELDS[0], rect: { left: 300, bottom: 50, right: 500, top: 70 } }]);
        assert.deepEqual((await (await withFields.page(0)).formFields()).map((f) => f.name), [existing.name, 'Email']);
        await assert.rejects(document.addFormFields([{ ...FIELDS[0], name: existing.name }]), invalid);
        await assert.rejects(document.addFormFields([FIELDS[0], FIELDS[0]]), invalid);
        await assert.rejects(document.addFormFields([{ ...FIELDS[0], name: ' ' }]), invalid);
    });
    test('an array held as its own object is read', async () => {
        const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n[2 0 R 3 0 R]\nendobj\n');
        const xref = new Map([[1, { offset: 9, generation: 0 }]]);
        const value = await readObject(bytes, xref, 1);
        assert.ok(Array.isArray(value) && value.length === 2);
    });
});
//# sourceMappingURL=form-fields.test.js.map