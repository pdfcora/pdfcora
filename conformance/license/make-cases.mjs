/**
 * Generates cases.json, the license contract every platform runs. Signatures are
 * randomised, so regenerating changes the keys but never the expectations.
 *
 *   node conformance/license/make-cases.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, signKey } from '../../tools/license/issue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PEM = join(HERE, 'test-private.pem');
if (!existsSync(PEM)) writeFileSync(PEM, generateKeyPair().privateKeyPem);
const privateKeyPem = readFileSync(PEM, 'utf8');
const jwk = createPublicKey(privateKeyPem).export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');

const APP = 'com.example.app';
const HOST = 'app.example.com';
const base = {
  v: 1, id: 'lic_test', customer: 'Example', modules: ['editing', 'signing'],
  ios: [APP], android: [APP], web: ['*.example.com'], server: false, expires: '2027-01-01',
};
const key = (changes) => signKey({ ...base, ...changes }, privateKeyPem);
const licensed = (modules) => ({ kind: 'licensed', modules });
const trial = (reason) => ({ kind: 'trial', reason });
const all = (value) => ({ ios: value, android: value, web: value });
const ALL_MODULES = ['ai', 'editing', 'forms', 'redaction', 'signing'];

const valid = key({});
const [, validPayload, validSignature] = valid.split('.');
const otherPayload = Buffer.from(JSON.stringify({ ...base, modules: ALL_MODULES })).toString('base64url');
const flipped = Buffer.from(validSignature, 'base64url'); flipped[10] ^= 0xff;

const cases = [
  { name: 'valid', key: valid, host: HOST, expected: all(licensed(['editing', 'signing'])) },
  { name: 'no key', key: null, host: HOST, expected: all(trial('noKey')) },
  { name: 'two parts', key: 'pk1.abc', host: HOST, expected: all(trial('malformed')) },
  { name: 'wrong prefix', key: `pk2.${validPayload}.${validSignature}`, host: HOST, expected: all(trial('malformed')) },
  { name: 'payload not json', key: `pk1.${Buffer.from('nope').toString('base64url')}.${validSignature}`, host: HOST, expected: all(trial('malformed')) },
  { name: 'tampered payload', key: `pk1.${otherPayload}.${validSignature}`, host: HOST, expected: all(trial('badSignature')) },
  { name: 'tampered signature', key: `pk1.${validPayload}.${flipped.toString('base64url')}`, host: HOST, expected: all(trial('badSignature')) },
  { name: 'signed by another key', key: signKey(base, generateKeyPair().privateKeyPem), host: HOST, expected: all(trial('badSignature')) },
  { name: 'unknown version', key: key({ v: 2 }), host: HOST, expected: all(trial('unsupportedVersion')) },
  { name: 'revoked', key: key({ id: 'lic_revoked' }), host: HOST, expected: all(trial('revoked')) },
  { name: 'expired before release', key: key({ expires: '2026-09-14' }), host: HOST, expected: all(trial('expired')) },
  { name: 'expires on release day', key: key({ expires: '2026-09-15' }), host: HOST, expected: all(licensed(['editing', 'signing'])) },
  { name: 'other apps', key: key({ ios: ['com.other'], android: ['com.other'], web: ['other.com'] }), host: HOST, expected: all(trial('wrongApp')) },
  { name: 'ios only', key: key({ android: undefined, web: undefined }), host: HOST,
    expected: { ios: licensed(['editing', 'signing']), android: trial('wrongApp'), web: trial('wrongApp') } },
  { name: 'exact host does not match subdomain', key: key({ web: ['example.com'] }), host: HOST,
    expected: { ios: licensed(['editing', 'signing']), android: licensed(['editing', 'signing']), web: trial('wrongApp') } },
  { name: 'wildcard is case-insensitive', key: key({ web: ['*.EXAMPLE.com'] }), host: 'App.Example.com', expected: all(licensed(['editing', 'signing'])) },
  { name: 'wildcard does not match bare domain', key: valid, host: 'example.com',
    expected: { ios: licensed(['editing', 'signing']), android: licensed(['editing', 'signing']), web: trial('wrongApp') } },
  { name: 'node without server', key: valid, host: null,
    expected: { ios: licensed(['editing', 'signing']), android: licensed(['editing', 'signing']), web: trial('wrongApp') } },
  { name: 'node with server', key: key({ server: true }), host: null, expected: all(licensed(['editing', 'signing'])) },
  { name: 'unknown module ignored', key: key({ modules: ['editing', 'teleport'] }), host: HOST, expected: all(licensed(['editing'])) },
  { name: 'every module', key: key({ modules: ALL_MODULES }), host: HOST, expected: all(licensed(ALL_MODULES)) },
];

const fullKey = key({ id: 'lic_full', modules: ALL_MODULES, server: true, web: ['*.example.com', 'localhost'] });
writeFileSync(join(HERE, 'cases.json'), JSON.stringify({
  publicKey, releaseDate: '2026-09-15', revoked: ['lic_revoked'], app: APP, fullKey, cases,
}, null, 2) + '\n');

// Keys for behaviour tests that need some modules but not others. Native tests cannot
// run node, so every platform reads these instead of signing its own.
const partial = (modules) => signKey({ ...base, id: 'lic_partial', modules, server: true }, privateKeyPem);
writeFileSync(join(HERE, 'partial-keys.json'), JSON.stringify({
  '': partial([]), forms: partial(['forms']), editing: partial(['editing']),
}, null, 2) + '\n');
console.log(`wrote ${cases.length} cases`);
