import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { addSignatureField } from '../dist/sign/field.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file) => new Uint8Array(readFileSync(`${CORPUS}${file}`));
const RESERVED = 8192;
/**
 * Everything except the cryptography, so the document surgery is proven on its own.
 * A signature over a structurally broken file is worthless, and debugging the two
 * together is where signing implementations go wrong.
 */
describe('placing a signature field', () => {
    test('the document still opens and keeps its pages and text', async () => {
        const base = read('hello_world.pdf');
        const before = await PdfDocument.open(base);
        const text = await (await before.page(0)).text.string();
        const { bytes } = addSignatureField(base, { reservedBytes: RESERVED });
        const after = await PdfDocument.open(bytes);
        assert.equal(await after.pageCount(), 1);
        assert.equal(await (await after.page(0)).text.string(), text);
    });
    test('the original bytes are untouched — this is an incremental update', () => {
        const base = read('hello_world.pdf');
        const { bytes } = addSignatureField(base, { reservedBytes: RESERVED });
        assert.ok(bytes.length > base.length);
        assert.deepEqual(bytes.subarray(0, base.length), base);
    });
    test('PDFium sees a signature where there was none', async () => {
        const base = read('hello_world.pdf');
        assert.equal((await (await PdfDocument.open(base)).signatures()).length, 0);
        const { bytes } = addSignatureField(base, { reservedBytes: RESERVED });
        const [signature] = await (await PdfDocument.open(bytes)).signatures();
        assert.ok(signature, 'FPDF_GetSignatureCount must find the new field');
        assert.equal(signature.subFilter, 'ETSI.CAdES.detached');
    });
    /** Off by one byte here and the signature protects the wrong span. */
    test('the byte range brackets the placeholder exactly', () => {
        const { bytes, contentsAt, contentsLength, byteRange } = addSignatureField(read('hello_world.pdf'), { reservedBytes: RESERVED });
        assert.equal(byteRange.length, 4);
        assert.equal(byteRange[0], 0);
        assert.equal(byteRange[1], contentsAt, 'the first span ends where the placeholder starts');
        assert.equal(byteRange[2], contentsAt + contentsLength, 'the second starts after it');
        assert.equal(byteRange[2] + byteRange[3], bytes.length, 'and runs to end of file');
    });
    /** The bracketed region must be the hex string itself, angle brackets included. */
    test('the placeholder is where the byte range says it is', () => {
        const { bytes, contentsAt, contentsLength } = addSignatureField(read('hello_world.pdf'), { reservedBytes: RESERVED });
        const gap = bytes.subarray(contentsAt, contentsAt + contentsLength);
        assert.equal(gap[0], '<'.charCodeAt(0));
        assert.equal(gap[gap.length - 1], '>'.charCodeAt(0));
        assert.ok(gap.subarray(1, -1).every((b) => b === '0'.charCodeAt(0)), 'the reserved space must be zeros, ready to be patched');
    });
    test('the reserved size is honoured', () => {
        const small = addSignatureField(read('hello_world.pdf'), { reservedBytes: 2048 });
        const large = addSignatureField(read('hello_world.pdf'), { reservedBytes: 8192 });
        assert.equal(small.contentsLength, 2048 * 2 + 2, 'hex, plus the angle brackets');
        assert.equal(large.contentsLength, 8192 * 2 + 2);
    });
    test('an existing AcroForm is extended, not replaced', async () => {
        const base = read('text_form.pdf');
        const fieldsBefore = (await (await (await PdfDocument.open(base)).page(0)).formFields()).length;
        assert.ok(fieldsBefore > 0, 'text_form.pdf must start with fields');
        const { bytes } = addSignatureField(base, { reservedBytes: RESERVED });
        const after = await (await (await PdfDocument.open(bytes)).page(0)).formFields();
        assert.equal(after.length, fieldsBefore + 1, 'the original fields must survive');
    });
    test('works on a document whose Catalog is in an object stream', async () => {
        const { bytes } = addSignatureField(read('bug_707673.pdf'), { reservedBytes: RESERVED });
        const [signature] = await (await PdfDocument.open(bytes)).signatures();
        assert.ok(signature, 'the compressed-Catalog path must work too');
    });
    test('the reason is carried into the signature dictionary', async () => {
        const { bytes } = addSignatureField(read('hello_world.pdf'), { reservedBytes: RESERVED, reason: 'Approved by finance' });
        const [signature] = await (await PdfDocument.open(bytes)).signatures();
        assert.equal(signature.reason, 'Approved by finance');
    });
    /**
     * `pdfsig` reads the field we place and agrees on the ranges:
     *
     *     - Signature Type: ETSI.CAdES.detached
     *     - Signed Ranges: [0 - 1168], [17554 - 17967]
     *     - Invalid or missing Signature string
     *
     * It also prints "Not total document signed" here, which is an artifact of the empty
     * placeholder rather than a disagreement: poppler determines coverage while validating
     * the signature, and validation aborts on a zero /Contents. Task 4 asserts that a
     * properly signed document makes it print "Total document signed".
     */
    test('our coverage computation matches the byte range we wrote', async () => {
        const { bytes, byteRange } = addSignatureField(read('hello_world.pdf'), { reservedBytes: RESERVED });
        const [signature] = await (await PdfDocument.open(bytes)).signatures();
        assert.deepEqual([...signature.byteRange], [...byteRange], 'PDFium must read back exactly the range we wrote');
        assert.equal(signature.coversWholeDocument, true);
    });
    test('an encrypted document is refused', () => {
        assert.throws(() => addSignatureField(read('encrypted_hello_world_r2.pdf'), { reservedBytes: RESERVED }), /encrypted/i);
    });
});
//# sourceMappingURL=sign-field.test.js.map