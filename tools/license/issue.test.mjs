import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { generateKeyPair, signKey } from './issue.mjs';

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

test('a signed key verifies with WebCrypto against the raw public key', async () => {
  const { privateKeyPem, publicKey } = generateKeyPair();
  assert.equal(b64(publicKey).length, 65);
  const key = signKey({ v: 1, id: 'lic_x', customer: 'X', modules: [], expires: '2030-01-01' }, privateKeyPem);
  const [prefix, payload, signature] = key.split('.');
  assert.equal(prefix, 'pk1');
  assert.equal(b64(signature).length, 64);
  const imported = await webcrypto.subtle.importKey('raw', b64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, imported, b64(signature), b64(payload)));
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).id, 'lic_x');
});
