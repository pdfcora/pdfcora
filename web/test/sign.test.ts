import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PdfDocument } from '../dist/index.js';
import type { CmsSigner } from '../dist/index.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const FIXTURES = new URL('../../conformance/fixtures/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));

const ANCHOR = new Uint8Array(readFileSync(`${FIXTURES}test-signer.der`));
const scratch = mkdtempSync(join(tmpdir(), 'pdfiumkit-sign-'));

/**
 * The SDK ships no CMS implementation on web, so the caller supplies one. This is what
 * an application would write; here it shells out to OpenSSL, which is a test dependency
 * and not a shipped one.
 */
function opensslSigner(): CmsSigner {
  return {
    async sign(data: Uint8Array): Promise<Uint8Array> {
      const input = join(scratch, `data-${Math.random().toString(36).slice(2)}.bin`);
      const output = `${input}.der`;
      writeFileSync(input, data);
      execFileSync('openssl', [
        // -cades adds signingCertificateV2, which ETSI.CAdES.detached requires.
        'cms', '-sign', '-binary', '-nosmimecap', '-cades', '-md', 'sha256',
        '-signer', `${FIXTURES}test-signer-cert.pem`,
        '-inkey', `${FIXTURES}test-signer-key.pem`,
        '-outform', 'DER', '-in', input, '-out', output,
      ]);
      return new Uint8Array(readFileSync(output));
    },
  };
}

const pdfsig = (bytes: Uint8Array): string => {
  const path = join(scratch, `signed-${Math.random().toString(36).slice(2)}.pdf`);
  writeFileSync(path, bytes);
  // pdfsig exits non-zero when it cannot reach a trust store, which is expected here.
  try {
    return execFileSync('pdfsig', [path], { encoding: 'utf8' });
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? '');
  }
};

describe('signing', () => {
  test('a signed document verifies with our own verifier', async () => {
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner(), reason: 'Approved' });

    const document = await PdfDocument.open(signed);
    const [signature] = await document.signatures();
    assert.ok(signature, 'the signature must be readable back');
    assert.equal(signature!.coversWholeDocument, true);

    const verdict = await document.verify(signature!, { trustAnchors: [ANCHOR] });
    assert.equal(verdict.kind, 'valid');
  });

  /**
   * The real gate. Our verifier agreeing with our own signer proves nothing — they would
   * share any bug. pdfsig is an independent implementation.
   *
   * "Total document signed" is also the assertion that settles the question left open in
   * Task 3, where the empty placeholder made poppler print the opposite.
   */
  test('a signed document verifies with pdfsig', async () => {
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner() });

    const report = pdfsig(signed);
    assert.match(report, /Signature is Valid/, report);
    assert.match(report, /Total document signed/, report);
  });

  test('a signed document still renders its original content', async () => {
    const base = read('hello_world.pdf');
    const before = await (await (await PdfDocument.open(base)).page(0)).text.string();

    const signed = await (await PdfDocument.open(base)).sign({ signer: opensslSigner() });
    const after = await (await (await PdfDocument.open(signed)).page(0)).text.string();
    assert.equal(after, before);
  });

  test('tampering with a document we signed is detected', async () => {
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner() });
    signed[100] ^= 0xff;

    const document = await PdfDocument.open(signed);
    const [signature] = await document.signatures();
    assert.equal((await document.verify(signature!, { trustAnchors: [ANCHOR] })).kind,
      'digestMismatch');
  });

  /** Self-signed, so it is valid and untrusted at once — like the UNH-IOL fixture. */
  test('without an anchor our own signature is untrusted, not valid', async () => {
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner() });
    const document = await PdfDocument.open(signed);
    const [signature] = await document.signatures();
    assert.equal((await document.verify(signature!)).kind, 'untrusted');
  });

  test('the reason is carried into the signature', async () => {
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner(), reason: 'Approved by finance' });
    const [signature] = await (await PdfDocument.open(signed)).signatures();
    assert.equal(signature!.reason, 'Approved by finance');
  });

  /** Too small a placeholder must fail loudly; silent truncation corrupts the file. */
  test('a signature that will not fit is refused', async () => {
    await assert.rejects(
      async () => (await PdfDocument.open(read('hello_world.pdf')))
        .sign({ signer: opensslSigner(), reservedBytes: 64 }),
      /reserved|too large|does not fit/i);
  });

  test('signs a document whose Catalog is in an object stream', async () => {
    const signed = await (await PdfDocument.open(read('bug_707673.pdf')))
      .sign({ signer: opensslSigner() });
    assert.match(pdfsig(signed), /Signature is Valid/);
  });

  test('signs a document that already has form fields', async () => {
    const signed = await (await PdfDocument.open(read('text_form.pdf')))
      .sign({ signer: opensslSigner() });
    assert.match(pdfsig(signed), /Signature is Valid/);
  });

  /**
   * The property the append-only writer exists for: a second signature must not
   * invalidate the first, though the first no longer covers the whole file.
   */
  test('signing twice leaves the first signature intact', async () => {
    const once = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner() });
    const twice = await (await PdfDocument.open(once)).sign({ signer: opensslSigner() });

    const document = await PdfDocument.open(twice);
    const signatures = await document.signatures();
    assert.equal(signatures.length, 2);

    assert.equal(signatures[0]!.coversWholeDocument, false, 'the first no longer covers all');
    assert.equal(signatures[1]!.coversWholeDocument, true);

    for (const signature of signatures) {
      assert.equal((await document.verify(signature, { trustAnchors: [ANCHOR] })).kind, 'valid',
        `signature ${signature.index} must still verify`);
    }
  });
});
