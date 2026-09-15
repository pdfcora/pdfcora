import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { serialize, name, ref, hexString, type PdfValue } from '../dist/writer/values.js';

const text = (value: PdfValue) => new TextDecoder().decode(serialize(value));

describe('PDF value serialisation', () => {
  test('names, refs, numbers and booleans', () => {
    assert.equal(text(name('Sig')), '/Sig');
    assert.equal(text(ref(12)), '12 0 R');
    assert.equal(text(ref(12, 3)), '12 3 R');
    assert.equal(text(42), '42');
    assert.equal(text(-1.5), '-1.5');
    assert.equal(text(true), 'true');
    assert.equal(text(null), 'null');
  });

  test('arrays and dictionaries nest', () => {
    assert.equal(text([1, 2, 3]), '[1 2 3]');
    assert.equal(text({ Type: name('Sig'), Contents: ref(4) }), '<</Type /Sig /Contents 4 0 R>>');
    assert.equal(text({ ByteRange: [0, 10, 20, 30] }), '<</ByteRange [0 10 20 30]>>');
  });

  test('strings escape delimiters rather than corrupting the file', () => {
    assert.equal(text('a(b)c\\d'), '(a\\(b\\)c\\\\d)');
    assert.equal(text('line\r\nbreak'), '(line\\r\\nbreak)');
  });

  /** Names have their own escaping rules; a space in a name ends it. */
  test('names escape characters that would terminate them', () => {
    assert.equal(text(name('a b')), '/a#20b');
    assert.equal(text(name('a/b')), '/a#2Fb');
  });

  test('non-ASCII strings are written as UTF-16BE with a byte order mark', () => {
    // PDF text strings are PDFDocEncoding or UTF-16BE; the BOM picks the latter.
    const out = text('café');
    assert.ok(out.startsWith('<FEFF'), out);
    assert.ok(out.endsWith('>'));
  });

  /**
   * The /Contents placeholder is patched in place after the byte range is known,
   * so its serialised width must be exactly predictable.
   */
  test('hex strings keep their exact byte width', () => {
    assert.equal(text(hexString(new Uint8Array(4))), '<00000000>');
    assert.equal(serialize(hexString(new Uint8Array(4096))).length, 4096 * 2 + 2);
  });

  test('an indirect object wraps its value', () => {
    const bytes = new TextDecoder().decode(serialize({ X: 1 }, { objectNumber: 7 }));
    assert.equal(bytes, '7 0 obj\n<</X 1>>\nendobj\n');
  });
});

describe('re-serialising a read dictionary', () => {
  /** Structure elements carry /T, /Lang and /ActualText; rewriting one must not alter them. */
  test('literal and hex strings come back byte for byte', async () => {
    const { parseDictionaryAt } = await import('../dist/writer/dictionary.js');
    const source = '<</T (a \\(b\\) c\\\\ \xe9) /Lang <FEFF0064> /ID [<ab12> <CD34>]>>';
    assert.equal(
      new TextDecoder('latin1').decode(serialize(parseDictionaryAt(source, 0))),
      '<</T (a \\(b\\) c\\\\ \xe9) /Lang <FEFF0064> /ID [<AB12> <CD34>]>>');
  });
});
