import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { readObject, readCatalog, refNumber } from '../dist/writer/read.js';
import { buildXref } from '../dist/writer/xref.js';
import { asName } from '../dist/writer/values.js';
import type { PdfValue } from '../dist/writer/values.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));

const entry = (value: PdfValue, key: string): PdfValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, PdfValue>)[key]
    : undefined;

const typeOf = (value: PdfValue) => asName(entry(value, 'Type') ?? null);

describe('reading objects', () => {
  test('reads the Catalog of a plain file', () => {
    const { value } = readCatalog(read('hello_world.pdf'));
    assert.equal(typeOf(value), 'Catalog');
    assert.ok(refNumber(value, 'Pages'), 'a Catalog always has /Pages');
  });

  /** The Catalog here is inside a compressed object stream. */
  test('reads a Catalog out of an object stream', () => {
    const { value } = readCatalog(read('bug_707673.pdf'));
    assert.equal(typeOf(value), 'Catalog');
  });

  /**
   * /AcroForm may be an inline dictionary or a reference, and real files use both —
   * text_form.pdf writes it inline. Signing has to merge into whichever it finds, so
   * the reader must reach /Fields either way.
   */
  test('reads an existing AcroForm whether it is inline or a reference', () => {
    const bytes = read('text_form.pdf');
    const catalog = readCatalog(bytes).value;

    const number = refNumber(catalog, 'AcroForm');
    const acroForm = number === undefined
      ? entry(catalog, 'AcroForm')
      : readObject(bytes, buildXref(bytes), number);

    assert.ok(acroForm, 'text_form.pdf has an AcroForm');
    assert.ok(entry(acroForm!, 'Fields'), 'an AcroForm has /Fields');
  });

  /**
   * Cross-reference streams are routinely written with /Predictor 12. Inflating without
   * undoing it yields plausible bytes and completely wrong offsets, which shows up as
   * "object not found" rather than as a decode error — three corpus files failed that
   * way before the predictor was implemented.
   */
  test('reads a Catalog behind a PNG-predicted xref stream', () => {
    for (const file of ['annotation_stamp_with_ap.pdf', 'embedded_attachments.pdf',
                        'signed_unh_iol.pdf']) {
      assert.equal(typeOf(readCatalog(read(file)).value), 'Catalog', file);
    }
  });

  test('reads the Pages tree root, following a reference', () => {
    const bytes = read('hello_world.pdf');
    const catalog = readCatalog(bytes).value;
    const pages = readObject(bytes, buildXref(bytes), refNumber(catalog, 'Pages')!);
    assert.equal(typeOf(pages!), 'Pages');
  });

  test('a missing object is undefined, not an exception', () => {
    const bytes = read('hello_world.pdf');
    assert.equal(readObject(bytes, buildXref(bytes), 9999), undefined);
  });

  test('the Catalog object number is reported, so it can be rewritten', () => {
    const { number } = readCatalog(read('hello_world.pdf'));
    assert.ok(number > 0);
    // Rewriting the Catalog is exactly what signing needs, so the number matters.
    const bytes = read('hello_world.pdf');
    assert.ok(buildXref(bytes).has(number));
  });

  /**
   * The gate for this task: every unencrypted document must yield its Catalog,
   * whichever xref style it uses and whether or not the object is compressed.
   */
  test('every unencrypted corpus document yields its Catalog', () => {
    const files = readdirSync(CORPUS)
      .filter((f) => f.endsWith('.pdf') && !f.startsWith('encrypted_'));
    assert.ok(files.length >= 19, 'the sweep must cover the corpus, not a sample');

    for (const file of files) {
      const { value } = readCatalog(read(file));
      assert.equal(typeOf(value), 'Catalog', `${file}: /Type /Catalog`);
    }
  });
});
