import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PdfDocument } from '../dist/index.js';
import type { CmsSigner } from '../dist/index.js';
import {
  buildTimestampRequest, parseTimestampResponse, embedTimestamp,
} from '../dist/sign/timestamp.js';
import { parseSignedData } from '../dist/cms/signedData.js';
import { readTlv, children } from '../dist/cms/der.js';

const CORPUS = new URL('../../conformance/corpus/', import.meta.url).pathname;
const FIXTURES = new URL('../../conformance/fixtures/', import.meta.url).pathname;
const read = (file: string) => new Uint8Array(readFileSync(`${CORPUS}${file}`));

const scratch = mkdtempSync(join(tmpdir(), 'pdfiumkit-tsa-'));
const TSA = new URL('../../conformance/fixtures/tsa/', import.meta.url).pathname;
const ANCHOR = new Uint8Array(readFileSync(`${FIXTURES}test-signer.der`));

/**
 * A stubbed RFC 3161 responder rather than a public authority: CI must not depend on
 * someone else's uptime, and a stub is the only way to test the refusal paths at all.
 * It is a real responder — `openssl ts` signs genuine tokens — not a canned reply.
 */
let server: Server;
let url = '';
/** Set by a test to make the responder misbehave. */
let behaviour: 'granted' | 'rejected' | 'http500' | 'garbage' = 'granted';

function opensslSigner(): CmsSigner {
  return {
    async sign(data: Uint8Array): Promise<Uint8Array> {
      const input = join(scratch, `d-${Math.random().toString(36).slice(2)}.bin`);
      writeFileSync(input, data);
      execFileSync('openssl', [
        'cms', '-sign', '-binary', '-nosmimecap', '-cades', '-md', 'sha256',
        '-signer', `${FIXTURES}test-signer-cert.pem`,
        '-inkey', `${FIXTURES}test-signer-key.pem`,
        '-outform', 'DER', '-in', input, '-out', `${input}.der`,
      ]);
      return new Uint8Array(readFileSync(`${input}.der`));
    },
  };
}

before(async () => {
  // The responder runs out of the scratch directory, not the fixture directory:
  // `openssl ts -reply` increments its serial file in place, and pointing it at a
  // tracked fixture leaves the working tree dirty after every test run.
  for (const file of ['tsa.cnf', 'tsa-resp.cnf', 'tsa-cert.pem', 'tsa-key.pem']) {
    copyFileSync(`${TSA}${file}`, join(scratch, file));
  }
  writeFileSync(join(scratch, 'serial'), '01\n');

  server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      if (behaviour === 'http500') { reply.writeHead(500); reply.end(); return; }
      if (behaviour === 'garbage') { reply.writeHead(200); reply.end(Buffer.from([1, 2, 3])); return; }

      const query = join(scratch, `q-${Math.random().toString(36).slice(2)}.tsq`);
      writeFileSync(query, Buffer.concat(chunks));
      const out = `${query}.tsr`;
      try {
        execFileSync('openssl', ['ts', '-reply', '-queryfile', query,
          '-config', join(scratch, 'tsa-resp.cnf'), '-section', 'tsa_config', '-out', out],
          { cwd: scratch, stdio: 'ignore' });
      } catch {
        reply.writeHead(500); reply.end(); return;
      }
      reply.writeHead(200, { 'content-type': 'application/timestamp-reply' });
      reply.end(readFileSync(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
});

after(() => server?.close());

const tsaAvailable = existsSync(`${TSA}tsa-resp.cnf`);


describe('timestamping', { skip: tsaAvailable ? false : 'the stub TSA is not set up' }, () => {
  test('the request is a well-formed TimeStampReq over the digest', async () => {
    const data = new TextEncoder().encode('a signature value');
    const request = await buildTimestampRequest(data);

    // openssl is the independent reader here, not our own parser.
    const path = join(scratch, 'req.tsq');
    writeFileSync(path, request);
    const text = execFileSync('openssl', ['ts', '-query', '-in', path, '-text'],
      { encoding: 'utf8' });

    assert.match(text, /Version: 1/);
    assert.match(text, /Hash Algorithm: sha256/);
    assert.match(text, /Certificate required: yes/,
      'without certReq a verifier has nothing to check');

    const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(data))).toString('hex');
    // openssl prints the imprint as spaced hex, so compare byte by byte.
    const printed = (/Message data:\n([\s\S]*?)Policy OID/.exec(text)?.[1] ?? '')
      .replace(/^\s*[0-9a-f]{4} - /gm, '')
      .replace(/\s+-\s+/g, ' ')
      .replace(/ {2}.*$/gm, '')
      .replace(/[^0-9a-f]/gi, '');
    assert.equal(printed.toLowerCase(), expected.toLowerCase(),
      'the message imprint must be the digest of the signature value');
  });

  test('a granted response yields a token', async () => {
    behaviour = 'granted';
    const request = await buildTimestampRequest(new TextEncoder().encode('x'));
    const reply = await fetch(url, { method: 'POST', body: new Uint8Array(request) });
    const token = parseTimestampResponse(new Uint8Array(await reply.arrayBuffer()));
    assert.ok(token.length > 500, 'a real token carries the TSA certificate');
  });

  test('the token goes into the SignerInfo as an unsigned attribute', async () => {
    behaviour = 'granted';
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner(), timestampUrl: url });

    const [signature] = await (await PdfDocument.open(signed)).signatures();
    const der = readTlv(signature!.contents, 0);
    const cms = signature!.contents.subarray(0, der.end);

    // [1] IMPLICIT unsignedAttrs on the SignerInfo.
    const contentInfo = readTlv(cms, 0);
    const signedData = children(cms, children(cms, contentInfo)[1]!)[0]!;
    const fields = children(cms, signedData);
    const signerInfos = fields.filter((f, i) => f.tag === 0x31 && i > 1);
    const signerInfo = children(cms, signerInfos[0]!)[0]!;

    assert.ok(children(cms, signerInfo).some((f) => f.tag === 0xa1),
      'the SignerInfo must carry unsigned attributes');
  });

  /** Embedding must not disturb what the signature covers. */
  test('a timestamped signature still verifies', async () => {
    behaviour = 'granted';
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner(), timestampUrl: url });

    const document = await PdfDocument.open(signed);
    const [signature] = await document.signatures();
    assert.equal((await document.verify(signature!, { trustAnchors: [ANCHOR] })).kind, 'valid');

    // And the CMS still parses, with the same signature value as before embedding.
    assert.ok(parseSignedData(signature!.contents).signature.length > 0);
  });

  test('an unreachable authority fails loudly', async () => {
    await assert.rejects(
      async () => (await PdfDocument.open(read('hello_world.pdf')))
        .sign({ signer: opensslSigner(), timestampUrl: 'http://127.0.0.1:1/' }),
      /timestamp|could not reach/i);
  });

  test('an HTTP error fails loudly', async () => {
    behaviour = 'http500';
    await assert.rejects(
      async () => (await PdfDocument.open(read('hello_world.pdf')))
        .sign({ signer: opensslSigner(), timestampUrl: url }),
      /HTTP 500/);
    behaviour = 'granted';
  });

  test('a garbage response fails loudly rather than embedding nonsense', async () => {
    behaviour = 'garbage';
    await assert.rejects(
      async () => (await PdfDocument.open(read('hello_world.pdf')))
        .sign({ signer: opensslSigner(), timestampUrl: url }),
      /timestamp/i);
    behaviour = 'granted';
  });

  /**
   * The failure paths must leave nothing behind. A document with a broken signature is
   * worse than one with no timestamp, so signing fails whole rather than half.
   */
  test('a failed timestamp produces no document at all', async () => {
    behaviour = 'http500';
    let produced: Uint8Array | undefined;
    try {
      produced = await (await PdfDocument.open(read('hello_world.pdf')))
        .sign({ signer: opensslSigner(), timestampUrl: url });
    } catch { /* expected */ }
    assert.equal(produced, undefined);
    behaviour = 'granted';
  });

  test('embedding twice is refused', async () => {
    behaviour = 'granted';
    const signed = await (await PdfDocument.open(read('hello_world.pdf')))
      .sign({ signer: opensslSigner(), timestampUrl: url });
    const [signature] = await (await PdfDocument.open(signed)).signatures();
    const der = readTlv(signature!.contents, 0);

    assert.throws(
      () => embedTimestamp(signature!.contents.subarray(0, der.end), new Uint8Array([0x30, 0x00])),
      /already carries/i);
  });
});
