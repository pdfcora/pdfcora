import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfDocument, PdfError } from '../dist/index.js';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CORPUS = join(ROOT, 'conformance', 'corpus');
const corpus = (name) => new Uint8Array(readFileSync(join(CORPUS, name)));
const open = (name) => PdfDocument.open(corpus(name));
describe('text', () => {
    test('extracts text', async () => {
        const document = await open('hello_world.pdf');
        const text = await (await document.page(0)).text.string();
        assert.ok(text.includes('Hello'), `expected 'Hello' in: ${text}`);
        await document.close();
    });
    test('character count is positive', async () => {
        const document = await open('hello_world.pdf');
        assert.ok((await (await document.page(0)).text.characterCount()) > 0);
        await document.close();
    });
    test('search finds a known term with rects', async () => {
        const document = await open('hello_world.pdf');
        const matches = await (await document.page(0)).text.search('Hello');
        assert.ok(matches.length > 0, 'search found nothing');
        assert.ok(matches[0].rects.length > 0, 'match has no rects');
        await document.close();
    });
    test('search for an absent term returns nothing', async () => {
        const document = await open('hello_world.pdf');
        assert.equal((await (await document.page(0)).text.search('zzzznotpresentzzzz')).length, 0);
        await document.close();
    });
});
describe('form fields', () => {
    test('combo box is discovered with options', async () => {
        const document = await open('combobox_form.pdf');
        const fields = await (await document.page(0)).formFields();
        assert.ok(fields.length > 0, 'no form fields found');
        const combo = fields.find((f) => f.kind === 'comboBox');
        assert.ok(combo, `expected a combo box, got ${fields.map((f) => f.kind).join(', ')}`);
        assert.ok(combo.kind === 'comboBox' && combo.options.length > 0, 'combo box has no options');
        await document.close();
    });
    test('text field round-trips a value', async () => {
        const document = await open('text_form.pdf');
        const page = await document.page(0);
        const target = (await page.formFields()).find((f) => f.kind === 'text');
        assert.ok(target);
        await page.setText('John Doe', target.annotationIndex);
        const updated = (await page.formFields()).find((f) => f.annotationIndex === target.annotationIndex);
        assert.ok(updated?.kind === 'text');
        assert.equal(updated.value, 'John Doe');
        await document.close();
    });
    test('checkbox state can be set', async () => {
        const document = await open('click_form.pdf');
        const page = await document.page(0);
        const target = (await page.formFields()).find((f) => f.kind === 'checkBox');
        assert.ok(target?.kind === 'checkBox');
        const before = target.isChecked;
        await page.setChecked(!before, target.annotationIndex);
        const updated = (await page.formFields()).find((f) => f.annotationIndex === target.annotationIndex);
        assert.ok(updated?.kind === 'checkBox');
        assert.notEqual(updated.isChecked, before, 'checkbox state did not change');
        await document.close();
    });
});
describe('annotations', () => {
    test('existing annotations are read', async () => {
        const document = await open('annotation_highlight_long_content.pdf');
        const annotations = await (await document.page(0)).annotations();
        assert.ok(annotations.length > 0, 'expected annotations');
        assert.ok(annotations.some((a) => a.kind === 'highlight'), `expected a highlight, got ${annotations.map((a) => a.kind).join(', ')}`);
        await document.close();
    });
    test('added ink is read back', async () => {
        const document = await open('hello_world.pdf');
        const page = await document.page(0);
        const before = (await page.annotations()).length;
        await page.addInk([{ x: 10, y: 10 }, { x: 50, y: 50 }, { x: 90, y: 20 }]);
        const after = await page.annotations();
        assert.equal(after.length, before + 1);
        const ink = after[after.length - 1];
        assert.equal(ink.kind, 'ink');
        assert.ok(ink.kind === 'ink' && ink.strokes.length === 1);
        assert.equal(ink.kind === 'ink' ? ink.strokes[0].length : 0, 3);
        await document.close();
    });
    test('added note carries its contents', async () => {
        const document = await open('hello_world.pdf');
        const page = await document.page(0);
        await page.addNote({ left: 10, bottom: 10, right: 40, top: 40 }, 'a review comment');
        const annotations = await page.annotations();
        assert.equal(annotations[annotations.length - 1].contents, 'a review comment');
        await document.close();
    });
    test('annotation can be removed', async () => {
        const document = await open('hello_world.pdf');
        const page = await document.page(0);
        await page.addNote({ left: 1, bottom: 1, right: 2, top: 2 }, 'x');
        const added = (await page.annotations()).length;
        await page.removeAnnotation(added - 1);
        assert.equal((await page.annotations()).length, added - 1);
        await document.close();
    });
});
describe('save round-trip', () => {
    test('edits survive save and reopen', async () => {
        const document = await open('hello_world.pdf');
        await (await document.page(0)).addNote({ left: 10, bottom: 10, right: 40, top: 40 }, 'persisted note');
        const saved = await document.toBytes();
        await document.close();
        assert.ok(saved.length > 0);
        const reopened = await PdfDocument.open(saved);
        const annotations = await (await reopened.page(0)).annotations();
        assert.ok(annotations.some((a) => a.contents === 'persisted note'), 'the note did not survive save/reopen');
        await reopened.close();
    });
    test('form value survives save and reopen', async () => {
        const document = await open('text_form.pdf');
        const page = await document.page(0);
        const target = (await page.formFields()).find((f) => f.kind === 'text');
        assert.ok(target);
        await page.setText('Persisted', target.annotationIndex);
        const saved = await document.toBytes();
        await document.close();
        const reopened = await PdfDocument.open(saved);
        const field = (await (await reopened.page(0)).formFields())
            .find((f) => f.annotationIndex === target.annotationIndex);
        assert.ok(field?.kind === 'text');
        assert.equal(field.value, 'Persisted');
        await reopened.close();
    });
});
describe('outline', () => {
    test('outline is readable', async () => {
        const document = await open('annots_action_handling.pdf');
        const outline = await document.outline();
        assert.ok(Array.isArray(outline)); // may legitimately be empty
        await document.close();
    });
});
describe('lifetime and errors', () => {
    test('using a closed document rejects with closed', async () => {
        const document = await open('hello_world.pdf');
        await document.close();
        await assert.rejects(() => document.pageCount(), (e) => {
            assert.ok(e instanceof PdfError);
            assert.equal(e.code, 'closed');
            return true;
        });
    });
    test('page out of range reports the bounds', async () => {
        const document = await open('hello_world.pdf');
        await assert.rejects(() => document.page(99), (e) => {
            assert.ok(e instanceof PdfError);
            assert.equal(e.code, 'pageOutOfRange');
            assert.match(e.message, /document has 1/);
            return true;
        });
        await document.close();
    });
    test('wrong password is distinguished from a missing one', async () => {
        const bytes = corpus('encrypted_hello_world_r2.pdf');
        await assert.rejects(() => PdfDocument.open(bytes), (e) => {
            assert.ok(e instanceof PdfError);
            assert.equal(e.code, 'passwordRequired');
            return true;
        });
        await assert.rejects(() => PdfDocument.open(bytes, 'definitely-not-it'), (e) => {
            assert.ok(e instanceof PdfError);
            assert.equal(e.code, 'wrongPassword');
            return true;
        });
    });
});
describe('concurrency', () => {
    /**
     * The core safety claim: many overlapping calls on one document must serialise
     * rather than re-enter the single-threaded engine.
     */
    test('concurrent access to one document is safe', async () => {
        const document = await open('many_rectangles.pdf');
        const page = await document.page(0);
        const results = await Promise.all(Array.from({ length: 32 }, async () => {
            const image = await page.render({ width: 64 });
            const text = await page.text.string();
            return image.width + text.length;
        }));
        assert.equal(results.length, 32);
        await document.close();
    });
    test('separate documents render independently', async () => {
        const widths = await Promise.all(['hello_world.pdf', 'rectangles.pdf', 'many_rectangles.pdf', 'text_font.pdf'].map(async (name) => {
            const document = await open(name);
            const image = await (await document.page(0)).render({ width: 120 });
            await document.close();
            return image.width;
        }));
        assert.deepEqual(widths, [120, 120, 120, 120]);
    });
});
//# sourceMappingURL=features.test.js.map