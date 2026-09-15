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
        // The state is a name, as the PDF spec requires; other viewers ignore a string /AS.
        const saved = new TextDecoder('latin1').decode(await document.toBytes('full'));
        assert.doesNotMatch(saved, /\/AS\s*\(/);
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
    test('added ink is read back as one annotation with every stroke', async () => {
        const document = await open('hello_world.pdf');
        const page = await document.page(0);
        const before = (await page.annotations()).length;
        await page.addInk([
            [{ x: 10, y: 10 }, { x: 50, y: 50 }, { x: 90, y: 20 }],
            [{ x: 20, y: 80 }, { x: 70, y: 80 }],
        ]);
        const after = await page.annotations();
        assert.equal(after.length, before + 1);
        const ink = after[after.length - 1];
        assert.ok(ink.kind === 'ink', `last annotation is ${ink.kind}`);
        assert.deepEqual(ink.strokes.map((s) => s.length), [3, 2]);
        assert.deepEqual(ink.rect, { left: 10, bottom: 10, right: 90, top: 80 });
        await document.close();
    });
    test('added highlight, underline and strikeout survive a save', async () => {
        const document = await open('hello_world.pdf');
        const page = await document.page(0);
        const quad = { p1: { x: 10, y: 60 }, p2: { x: 90, y: 60 }, p3: { x: 10, y: 50 }, p4: { x: 90, y: 50 } };
        await page.addHighlight([quad]);
        await page.addUnderline([quad]);
        await page.addStrikeout([quad]);
        const reopened = await PdfDocument.open(await document.toBytes());
        const kinds = (await (await reopened.page(0)).annotations()).map((a) => a.kind);
        assert.deepEqual(kinds.slice(-3), ['highlight', 'underline', 'strikeout']);
        await reopened.close();
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
    // A closed document's handle is reused by the next one opened. Form state keyed on
    // that handle and left behind by close() silently swallowed every later edit.
    test('form value survives save when earlier form documents were closed', async () => {
        for (let i = 0; i < 10; i++) {
            const earlier = await open(i % 2 ? 'combobox_form.pdf' : 'click_form.pdf');
            await (await earlier.page(0)).formFields();
            await earlier.close();
            const document = await open('text_form.pdf');
            const page = await document.page(0);
            const target = (await page.formFields()).find((f) => f.kind === 'text');
            assert.ok(target);
            await page.setText(`value ${i}`, target.annotationIndex);
            const saved = await document.toBytes();
            const reopened = await PdfDocument.open(saved);
            const field = (await (await reopened.page(0)).formFields())
                .find((f) => f.annotationIndex === target.annotationIndex);
            await reopened.close();
            await document.close();
            assert.ok(field?.kind === 'text');
            assert.equal(field.value, `value ${i}`, `cycle ${i}`);
        }
    });
});
describe('links and geometry', () => {
    test('links resolve to URIs and internal pages', async () => {
        const document = await open('annots_action_handling.pdf');
        const links = await (await document.page(0)).links();
        assert.ok(links.length > 0, 'expected links');
        assert.ok(links.some((l) => l.target.kind === 'uri'), 'expected a URI target');
        assert.ok(links.some((l) => l.target.kind === 'page'), 'expected an internal page target');
        await document.close();
    });
    test('character bounding box is readable', async () => {
        const document = await open('hello_world.pdf');
        const box = await (await document.page(0)).characterBox(0);
        assert.ok(box.right > box.left, `expected positive width: ${JSON.stringify(box)}`);
        assert.ok(box.top > box.bottom, `expected positive height: ${JSON.stringify(box)}`);
        await document.close();
    });
});
describe('render flags', () => {
    /**
     * The `forms` option was accepted and silently ignored once: FPDF_FFLDraw was never
     * called, so filled field values never appeared in a web render. Matches the iOS
     * behaviour, where `.forms` paints the value and `.annotations` alone does not.
     */
    test('forms flag paints the field value and its absence does not', async () => {
        const document = await open('text_form.pdf');
        const page = await document.page(0);
        const field = (await page.formFields()).find((f) => f.kind === 'text');
        assert.ok(field);
        await page.setText('WIDGETVALUE', field.annotationIndex);
        const size = await page.size();
        const inkInField = async (forms) => {
            const image = await page.render({ width: 300, forms });
            const s = 300 / size.width;
            const r = field.rect;
            let count = 0;
            for (let y = Math.floor((size.height - r.top) * s); y < Math.ceil((size.height - r.bottom) * s); y++) {
                for (let x = Math.floor(r.left * s); x < Math.ceil(r.right * s); x++) {
                    const i = (y * image.width + x) * 4;
                    if (image.data[i] < 200 || image.data[i + 1] < 200 || image.data[i + 2] < 200)
                        count++;
                }
            }
            return count;
        };
        assert.ok((await inkInField(true)) > 0, 'forms: true should paint the value');
        assert.equal(await inkInField(false), 0, 'forms: false must not paint the value');
        await document.close();
    });
});
describe('attachments', () => {
    test('embedded files are listed and extracted', async () => {
        const document = await open('embedded_attachments.pdf');
        const list = await document.attachments();
        assert.deepEqual(list.map((a) => a.name), ['1.txt', 'attached.pdf']);
        const text = await document.attachmentData(0);
        assert.equal(new TextDecoder().decode(text), 'test');
        // Guards a wasm32 trap: `unsigned long` out-parameters are 32-bit, and reading
        // them as 64-bit returns absurd sizes rather than failing outright.
        const nested = await document.attachmentData(1);
        assert.ok(nested.length > 1000 && nested.length < 100_000, `implausible size ${nested.length}`);
        assert.equal(new TextDecoder().decode(nested.slice(0, 5)), '%PDF-');
        await document.close();
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