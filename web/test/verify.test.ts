import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfDocument } from '../dist/index.js';
import type { PdfSignature } from '../dist/index.js';
import { parseSignedData } from '../dist/cms/signedData.js';
import { checkDigest } from '../dist/cms/verify.js';
import { readTlv } from '../dist/cms/der.js';

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const ANCHOR = new URL('../../conformance/fixtures/unh-iol-signer.der', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));

/**
 * `pdfsig` reports both of these about the fixture, at the same time:
 *
 *     Signature Validation:   Signature is Valid.
 *     Certificate Validation: Certificate issuer is unknown.
 *
 * Integrity and trust are separate answers. Collapsing them into one is the defect
 * this whole phase exists to avoid, so it is the first test.
 */
describe('verifying a signature', () => {
  let bytes: Uint8Array;
  let signature: PdfSignature;
  let document: PdfDocument;

  before(async () => {
    bytes = read('signed_unh_iol.pdf');
    document = await PdfDocument.open(bytes);
    const [first] = await document.signatures();
    signature = first!;
  });

  test('a cryptographically valid signature from an unknown issuer is untrusted', async () => {
    const verdict = await document.verify(signature);
    assert.equal(verdict.kind, 'untrusted');
    assert.ok(verdict.kind === 'untrusted' && verdict.chain.length > 0,
      'the chain is reported even when it is not trusted');
    assert.match(
      verdict.kind === 'untrusted' ? verdict.chain[0]!.commonName ?? '' : '', /UNH-IOL/);
  });

  test('the same signature is valid once its own certificate is an anchor', async () => {
    const anchor = new Uint8Array(readFileSync(ANCHOR));
    const verdict = await document.verify(signature, { trustAnchors: [anchor] });
    assert.equal(verdict.kind, 'valid');
    assert.match(verdict.kind === 'valid' ? verdict.signer.commonName ?? '' : '', /UNH-IOL/);
  });

  test('the anchor taken from the CMS itself works the same way', async () => {
    const cms = parseSignedData(signature.contents);
    const verdict = await document.verify(signature, { trustAnchors: [cms.certificates.at(-1)!] });
    assert.equal(verdict.kind, 'valid');
  });

  /** Tampering is an integrity failure and must not be reported as a trust problem. */
  test('a changed byte is a digest mismatch, not untrusted', async () => {
    const tampered = new Uint8Array(bytes);
    tampered[100] ^= 0xff;
    const doc = await PdfDocument.open(tampered);
    const [sig] = await doc.signatures();
    assert.equal((await doc.verify(sig!)).kind, 'digestMismatch');
  });

  /** …and it stays a mismatch even when the signer is fully trusted. */
  test('a trusted anchor does not rescue a tampered document', async () => {
    const anchor = new Uint8Array(readFileSync(ANCHOR));
    const tampered = new Uint8Array(bytes);
    tampered[100] ^= 0xff;
    const doc = await PdfDocument.open(tampered);
    const [sig] = await doc.signatures();
    assert.equal((await doc.verify(sig!, { trustAnchors: [anchor] })).kind, 'digestMismatch');
  });

  /**
   * The digest check runs first and catches a changed document, so this corrupts only
   * the RSA signature value — leaving the messageDigest intact — to prove the signature
   * itself is actually verified rather than assumed.
   */
  test('a corrupted signature value fails even when the digest still matches', async () => {
    const cms = parseSignedData(signature.contents);
    const contents = new Uint8Array(signature.contents);

    // Locate the signature value inside the blob rather than assuming an offset: the
    // last bytes of `contents` are padding, not DER (see the padding test below).
    const at = indexOfBytes(contents, cms.signature);
    assert.ok(at > 0, 'the signature value must be findable in the blob');
    contents[at + 8] ^= 0xff;
    const forged = { ...signature, contents };

    assert.equal(await checkDigest(bytes, forged), true, 'the document itself is untouched');
    const anchor = new Uint8Array(readFileSync(ANCHOR));
    assert.equal((await document.verify(forged, { trustAnchors: [anchor] })).kind, 'digestMismatch');
  });

  /**
   * PDFium hands back the whole /Contents placeholder, which a signer pads with zeros
   * to a fixed reserved size. The DER ends well before the blob does, so anything that
   * indexes from the end of `contents` is indexing into padding.
   */
  test('contents is the padded placeholder, not just the DER', async () => {
    const der = readTlv(signature.contents, 0);
    assert.ok(der.end < signature.contents.length,
      'the fixture pads its placeholder, so this guards the assumption');
    assert.ok(signature.contents.subarray(der.end).every((b) => b === 0),
      'everything after the DER should be padding');
  });

  test('a malformed PKCS#7 is reported, not thrown', async () => {
    const broken = { ...signature, contents: new Uint8Array([1, 2, 3]) };
    const verdict = await document.verify(broken);
    assert.equal(verdict.kind, 'malformed');
  });

  test('an unrelated certificate is not accepted as an anchor', async () => {
    // A well-formed certificate that did not issue this signature.
    const anchor = new Uint8Array(readFileSync(ANCHOR));
    const unrelated = new Uint8Array(anchor);
    unrelated[unrelated.length - 1] ^= 0xff;      // break its signature, keep its shape
    const verdict = await document.verify(signature, { trustAnchors: [unrelated] });
    assert.equal(verdict.kind, 'untrusted');
  });

  /**
   * Appending after signing leaves the signature intact over its own ranges. The
   * verdict stays valid; it is `coversWholeDocument` that reports the danger.
   */
  test('an amended document still verifies, but does not cover the whole file', async () => {
    const { scanTrailer, nextObjectNumber } = await import('../dist/writer/scan.js');
    const { appendUpdate } = await import('../dist/writer/incremental.js');
    const { name } = await import('../dist/writer/values.js');

    const info = scanTrailer(bytes);
    const amended = appendUpdate(bytes, new Map([[nextObjectNumber(info), { Type: name('X') }]]));
    const doc = await PdfDocument.open(amended);
    const [sig] = await doc.signatures();

    const anchor = new Uint8Array(readFileSync(ANCHOR));
    assert.equal((await doc.verify(sig!, { trustAnchors: [anchor] })).kind, 'valid');
    assert.equal(sig!.coversWholeDocument, false, 'the appended bytes are unprotected');
  });
});
