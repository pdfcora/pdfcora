import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { parseSignedData } from '../dist/cms/signedData.js';
const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
/** Written by `openssl pkcs7 -print_certs`; see conformance/fixtures/README.md. */
const REFERENCE_CERT = new URL('../../conformance/fixtures/unh-iol-signer.der', import.meta.url).pathname;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
/**
 * Expectations come from `openssl asn1parse`, not from this reader:
 *
 *     1161: INTEGER  :4BB35DB9A6994675E459          (signer serial)
 *     1175: OBJECT   :sha256                        (digest algorithm)
 *     1188: cont [0] l=92                           (signed attributes)
 *     1248: OCTET STRING 9F9DF165...FEFD73          (messageDigest attribute)
 *     1284: OBJECT   :sha256WithRSAEncryption       (signature algorithm)
 *     1297: OCTET STRING l=256                      (signature value)
 */
describe('CMS SignedData', () => {
    let pkcs7;
    before(async () => {
        const bytes = new Uint8Array(readFileSync(`${CORPUS}signed_unh_iol.pdf`));
        const [signature] = await (await PdfDocument.open(bytes)).signatures();
        pkcs7 = signature.contents;
    });
    /**
     * Compared byte for byte against what OpenSSL extracts from the same blob, so the
     * certificate boundaries are confirmed by a tool that does not share our parser.
     */
    test('extracts the certificate exactly as OpenSSL does', () => {
        const cms = parseSignedData(pkcs7);
        assert.equal(cms.certificates.length, 1, 'the fixture carries one self-signed certificate');
        const reference = new Uint8Array(readFileSync(REFERENCE_CERT));
        assert.equal(cms.certificates[0].length, reference.length);
        assert.deepEqual([...cms.certificates[0]], [...reference]);
    });
    test('extracts the algorithms', () => {
        const cms = parseSignedData(pkcs7);
        assert.equal(cms.digestAlgorithm, '2.16.840.1.101.3.4.2.1'); // sha256
        assert.equal(cms.signatureAlgorithm, '1.2.840.113549.1.1.11'); // sha256WithRSA
    });
    test('extracts the signer serial number', () => {
        assert.equal(parseSignedData(pkcs7).signerSerial, 0x4bb35db9a6994675e459n);
    });
    test('extracts the messageDigest signed attribute', () => {
        const cms = parseSignedData(pkcs7);
        assert.equal(cms.messageDigest?.length, 32, 'SHA-256 is 32 bytes');
        assert.equal(hex(cms.messageDigest), '9F9DF165ED1A251D0644F7DE9B1BC1C71328D4F139209F1BD28336E9D1FEFD73');
    });
    test('extracts the signature value', () => {
        assert.equal(parseSignedData(pkcs7).signature.length, 256, 'a 2048-bit RSA signature');
    });
    /**
     * The signature is computed over the SET encoding, not the `[0] IMPLICIT` form the
     * file stores. Returning the stored bytes makes every signature appear invalid, and
     * the failure looks like a bad certificate rather than a bad parser.
     */
    test('signed attributes are re-tagged as a SET', () => {
        const attrs = parseSignedData(pkcs7).signedAttrs;
        assert.equal(attrs[0], 0x31, 'must be SET (0x31), not [0] IMPLICIT (0xa0)');
        assert.equal(attrs.length, 94, 'the 92-byte value plus its two-byte header');
    });
    test('rejects a blob that is not SignedData', () => {
        const notCms = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);
        assert.throws(() => parseSignedData(notCms), /signedData|content type/i);
    });
    test('rejects a truncated blob without crashing', () => {
        assert.throws(() => parseSignedData(pkcs7.subarray(0, 200)), /DER|truncated|signedData/i);
    });
});
//# sourceMappingURL=signed-data.test.js.map