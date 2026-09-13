import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PdfDocument } from '../dist/index.js';
import { scanTrailer, nextObjectNumber } from '../dist/writer/scan.js';
import { appendUpdate } from '../dist/writer/incremental.js';
import { name } from '../dist/writer/values.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(join(CORPUS, file)));

/**
 * Expectations come from `pdfsig`, not from this SDK, so a bug here cannot be
 * confirmed by a matching bug in our own reader:
 *
 *   Signer Certificate Common Name: UNH-IOL
 *   Signing Time: Jan 05 2026 16:23:15
 *   Signature Type: adbe.pkcs7.detached
 *   Signed Ranges: [0 - 151484], [156392 - 297957]
 *   Total document signed
 */
describe('reading signatures', () => {
  test('reads the signature of a real signed document', async () => {
    const doc = await PdfDocument.open(read('signed_unh_iol.pdf'));
    const signatures = await doc.signatures();

    assert.equal(signatures.length, 1);
    const [signature] = signatures;
    assert.equal(signature!.subFilter, 'adbe.pkcs7.detached');
    assert.deepEqual(signature!.byteRange, [0, 151484, 156392, 141565]);
    assert.ok(signature!.contents.length > 0, 'the PKCS#7 blob must come back');
  });

  test('reports the signing time the signer claimed', async () => {
    const doc = await PdfDocument.open(read('signed_unh_iol.pdf'));
    const [signature] = await doc.signatures();
    // 2026-01-05 16:23:15, as pdfsig reports it.
    assert.equal(signature!.signingTime?.getUTCFullYear(), 2026);
    assert.equal(signature!.signingTime?.getUTCMonth(), 0);
    assert.equal(signature!.signingTime?.getUTCDate(), 5);
  });

  test('an unsigned document reports no signatures', async () => {
    const doc = await PdfDocument.open(read('hello_world.pdf'));
    assert.deepEqual(await doc.signatures(), []);
  });

  /**
   * pdfsig says "Total document signed": the last byte range span ends at EOF.
   * This is computed rather than read, and getting it wrong is the failure that
   * lets a signed document be silently amended.
   */
  test('reports that the signature covers the whole file', async () => {
    const doc = await PdfDocument.open(read('signed_unh_iol.pdf'));
    const [signature] = await doc.signatures();
    assert.equal(signature!.coversWholeDocument, true);
  });

  test('a signature that stops short of EOF is not reported as covering it', async () => {
    const base = read('signed_unh_iol.pdf');
    const info = scanTrailer(base);
    // Amend the document after it was signed, exactly as an attacker would.
    const amended = appendUpdate(
      base, new Map([[nextObjectNumber(info), { Type: name('Unused') }]]));

    const doc = await PdfDocument.open(amended);
    const [signature] = await doc.signatures();
    assert.ok(signature, 'the signature must still be found after the amendment');
    assert.equal(signature!.coversWholeDocument, false,
                 'content was appended after the signed range');
  });
});
