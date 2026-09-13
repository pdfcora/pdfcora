import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { readTlv, children, readOid, readInteger, DerError } from '../dist/cms/der.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
/**
 * The DER reader runs on a PKCS#7 blob taken from an arbitrary PDF, so malformed input
 * is the expected case. The contract is narrow and absolute: every input either parses
 * or throws a DerError. Never a RangeError, never a hang, never a silent wrong answer.
 */
describe('DER reader survives malformed input', () => {
    /**
     * Walks the whole tree, asserting the invariant that actually matters.
     *
     * "Parses or throws" is too weak on its own: JavaScript clamps `subarray` and yields
     * `undefined` for an out-of-range index, so a missing bounds check corrupts silently
     * instead of raising. Every TLV must therefore be inside the buffer it came from.
     */
    function walk(bytes, depth = 0, tlv = readTlv(bytes, 0)) {
        if (depth > 32)
            return 0; // real CMS nests ~8 deep
        assert.ok(tlv.contentStart <= bytes.length && tlv.contentEnd <= bytes.length
            && tlv.end <= bytes.length && tlv.length >= 0, `TLV tag 0x${tlv.tag.toString(16)} reports ${tlv.contentStart}..${tlv.end} `
            + `in a ${bytes.length}-byte buffer`);
        if (tlv.tag === 0x06)
            readOid(bytes, tlv);
        if (tlv.tag === 0x02)
            readInteger(bytes, tlv);
        let count = 1;
        for (const child of children(bytes, tlv))
            count += walk(bytes, depth + 1, child);
        return count;
    }
    let pkcs7;
    test('setup: take a real PKCS#7 blob to mutate', async () => {
        const bytes = new Uint8Array(readFileSync(`${CORPUS}signed_unh_iol.pdf`));
        const [signature] = await (await PdfDocument.open(bytes)).signatures();
        pkcs7 = signature.contents;
        assert.ok(pkcs7.length > 1000, 'the fixture should carry a real signature');
    });
    test('10,000 mutations either parse or throw a DerError', () => {
        let seed = 0x9e3779b9;
        const random = () => {
            // xorshift, so the run is deterministic and a failure can be reproduced.
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            return (seed >>> 0) / 0x1_0000_0000;
        };
        let parsed = 0;
        let rejected = 0;
        for (let i = 0; i < 10_000; i++) {
            const mutated = new Uint8Array(pkcs7);
            const kind = i % 3;
            if (kind === 0) {
                // Flip a byte.
                mutated[Math.floor(random() * mutated.length)] ^= 1 << Math.floor(random() * 8);
            }
            else if (kind === 1) {
                // Corrupt a length octet specifically, which is where the danger lives.
                const at = Math.floor(random() * Math.min(mutated.length, 64));
                mutated[at] = Math.floor(random() * 256);
            }
            const input = kind === 2
                ? mutated.subarray(0, 1 + Math.floor(random() * mutated.length)) // truncate
                : mutated;
            try {
                walk(input);
                parsed++;
            }
            catch (error) {
                assert.ok(error instanceof DerError || error instanceof RangeError === false, `mutation ${i} threw ${error.name}: ${error.message}`);
                assert.ok(error instanceof DerError, `mutation ${i} threw ${error.name}, not DerError: ${error.message}`);
                rejected++;
            }
        }
        assert.equal(parsed + rejected, 10_000);
        // A run that rejected everything, or accepted everything, would not be testing much.
        assert.ok(rejected > 100, `only ${rejected} mutations were rejected`);
        assert.ok(parsed > 100, `only ${parsed} mutations parsed`);
    });
    test('a buffer of random bytes does not hang or crash', () => {
        for (let length = 0; length < 64; length++) {
            const bytes = new Uint8Array(length).map((_, i) => (i * 37 + length * 11) & 0xff);
            try {
                walk(bytes);
            }
            catch (error) {
                assert.ok(error instanceof DerError, `length ${length}: ${error.name}`);
            }
        }
    });
});
//# sourceMappingURL=der-fuzz.test.js.map