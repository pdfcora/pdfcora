import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));

const objectsOf = async (file: string, pageIndex = 0) =>
  (await (await PdfDocument.open(read(file))).page(pageIndex)).objects();

/**
 * Expectations come from probing the engine directly, so they are measurements rather
 * than guesses:
 *
 *   hello_world.pdf              [0] text l=20.2 b=48.3  r=83.5  t=58.2  "Hello, world!"
 *                                [1] text l=20.8 b=96.6  r=135.0 t=111.8 "Goodbye, world!"
 *   rectangles.pdf               8 path objects
 *   annotation_stamp_with_ap.pdf 32 objects, [0] text "Adobe Acrobat PDF Files"
 */
describe('page objects', () => {
  test('lists the objects on a page with their bounds', async () => {
    const objects = await objectsOf('hello_world.pdf');

    assert.equal(objects.length, 2, 'hello_world.pdf has two text objects');
    assert.ok(objects.every((o) => o.kind === 'text'));

    const [hello, goodbye] = objects;
    assert.ok(Math.abs(hello!.bounds.left - 20.2) < 0.5, `left was ${hello!.bounds.left}`);
    assert.ok(Math.abs(hello!.bounds.top - 58.2) < 0.5, `top was ${hello!.bounds.top}`);
    // PDF space grows upward, so the second object sits above the first.
    assert.ok(goodbye!.bounds.bottom > hello!.bounds.top);
  });

  test('reads the text each object carries', async () => {
    const objects = await objectsOf('hello_world.pdf');
    assert.equal(objects[0]!.text, 'Hello, world!');
    assert.equal(objects[1]!.text, 'Goodbye, world!');
  });

  test('reports the index, so an object can be removed later', async () => {
    const objects = await objectsOf('hello_world.pdf');
    assert.deepEqual(objects.map((o) => o.index), [0, 1]);
  });

  test('reports the font size, which a split must preserve', async () => {
    const objects = await objectsOf('hello_world.pdf');
    assert.equal(objects[1]!.fontSize, 16);
  });

  /** Not everything on a page is text; a redaction region can cover any of it. */
  test('paths are reported as paths, with no text', async () => {
    const objects = await objectsOf('rectangles.pdf');
    assert.equal(objects.length, 8);
    assert.ok(objects.every((o) => o.kind === 'path'));
    assert.ok(objects.every((o) => o.text === undefined));
  });

  test('a page of many objects is listed in full', async () => {
    const objects = await objectsOf('annotation_stamp_with_ap.pdf');
    assert.equal(objects.length, 32);
    assert.equal(objects[0]!.text, 'Adobe Acrobat PDF Files');
  });

  /** Bounds are in PDF space, the same space a redaction region is given in. */
  test('bounds are normalised so left <= right and bottom <= top', async () => {
    for (const file of ['hello_world.pdf', 'rectangles.pdf', 'annotation_stamp_with_ap.pdf']) {
      for (const object of await objectsOf(file)) {
        assert.ok(object.bounds.left <= object.bounds.right, `${file}: ${JSON.stringify(object.bounds)}`);
        assert.ok(object.bounds.bottom <= object.bounds.top, `${file}: ${JSON.stringify(object.bounds)}`);
      }
    }
  });

  test('every unencrypted corpus document lists its first page without error', async () => {
    const files = ['hello_world.pdf', 'text_form.pdf', 'rectangles.pdf', 'text_font.pdf',
                   'hebrew_mirrored.pdf', 'tagged_actual_text.pdf', 'many_rectangles.pdf'];
    for (const file of files) {
      assert.ok(Array.isArray(await objectsOf(file)), file);
    }
  });
});
