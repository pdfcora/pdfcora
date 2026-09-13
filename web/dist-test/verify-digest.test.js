import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { digestOverRanges, checkDigest } from '../dist/cms/verify.js';
import { parseSignedData } from '../dist/cms/signedData.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file) => new Uint8Array(readFileSync(`${CORPUS}${file}`));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
/**
 * `pdfsig` reports "Signed Ranges: [0 - 151484], [156392 - 297957]" and
 * "Signature Validation: Signature is Valid", so the signed bytes must still hash to
 * the messageDigest attribute openssl showed:
 * 9F9DF165ED1A251D0644F7DE9B1BC1C71328D4F139209F1BD28336E9D1FEFD73
 */
describe('digest over the signed ranges', () => {
    let bytes;
    let signature;
    before(async () => {
        bytes = read('signed_unh_iol.pdf');
        const [first] = await (await PdfDocument.open(bytes)).signatures();
        signature = first;
    });
    test('the signed ranges hash to the messageDigest attribute', async () => {
        const digest = await digestOverRanges(bytes, signature.byteRange, 'SHA-256');
        assert.equal(hex(digest), '9F9DF165ED1A251D0644F7DE9B1BC1C71328D4F139209F1BD28336E9D1FEFD73');
        assert.equal(await checkDigest(bytes, signature), true);
    });
    /** The whole point: one changed byte inside a signed range must be caught. */
    test('a single changed byte inside a signed range breaks the digest', async () => {
        const tampered = new Uint8Array(bytes);
        tampered[100] ^= 0xff; // inside [0 - 151484]
        assert.equal(await checkDigest(tampered, signature), false);
    });
    test('a change near the end of the second range is caught too', async () => {
        const tampered = new Uint8Array(bytes);
        tampered[bytes.length - 20] ^= 0xff; // inside [156392 - 297957]
        assert.equal(await checkDigest(tampered, signature), false);
    });
    /**
     * The gap between the ranges is the /Contents placeholder holding the signature
     * itself. It is genuinely not covered, and claiming otherwise would be wrong.
     */
    test('a byte changed in the /Contents gap does not break the digest', async () => {
        const gapStart = signature.byteRange[0] + signature.byteRange[1];
        const poked = new Uint8Array(bytes);
        poked[gapStart + 10] ^= 0xff;
        assert.equal(await checkDigest(poked, signature), true);
    });
    test('the two ranges are hashed in order, not concatenated arbitrarily', async () => {
        const [start1, length1, start2, length2] = signature.byteRange;
        const swapped = [start2, length2, start1, length1];
        const digest = await digestOverRanges(bytes, swapped, 'SHA-256');
        assert.notEqual(hex(digest), hex(await digestOverRanges(bytes, signature.byteRange, 'SHA-256')));
    });
    test('a range running past the file is refused, not clamped', async () => {
        await assert.rejects(() => digestOverRanges(bytes, [0, bytes.length + 1], 'SHA-256'), /range|bounds/i);
    });
    test('an unknown digest algorithm is refused', async () => {
        const cms = parseSignedData(signature.contents);
        assert.equal(cms.digestAlgorithm, '2.16.840.1.101.3.4.2.1');
        await assert.rejects(() => digestOverRanges(bytes, signature.byteRange, 'SHA-1024'), /algorithm|unsupported/i);
    });
});
//# sourceMappingURL=verify-digest.test.js.map