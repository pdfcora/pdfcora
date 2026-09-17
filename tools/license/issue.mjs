#!/usr/bin/env node
/**
 * Issues PDFCora license keys.
 *
 *   node tools/license/issue.mjs keygen --out <dir>
 *   node tools/license/issue.mjs sign --private-key <pem> --id lic_… --customer Acme
 *       --modules editing,signing --ios com.acme.app --android com.acme.app
 *       --web acme.com,*.acme.com [--server] --expires 2027-09-15
 *
 * The production private key never enters the repository.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: raw.toString('base64url'),
  };
}

export function signKey(payload, privateKeyPem) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign('sha256', bytes, { key: createPrivateKey(privateKeyPem), dsaEncoding: 'ieee-p1363' });
  return `pk1.${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

function option(args, name) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}
const list = (value) => (value ? value.split(',').filter(Boolean) : undefined);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'keygen') {
    const out = option(args, 'out');
    if (!out) throw new Error('--out is required');
    const { privateKeyPem, publicKey } = generateKeyPair();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'license-private.pem'), privateKeyPem, { mode: 0o600 });
    console.log(`private key: ${join(out, 'license-private.pem')}`);
    console.log(`public key:  ${publicKey}`);
  } else if (command === 'sign') {
    const expires = option(args, 'expires');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires ?? '')) throw new Error('--expires YYYY-MM-DD is required');
    const payload = {
      v: 1,
      id: option(args, 'id') ?? `lic_${Date.now().toString(36)}`,
      customer: option(args, 'customer') ?? '',
      modules: list(option(args, 'modules')) ?? [],
      ...(list(option(args, 'ios')) ? { ios: list(option(args, 'ios')) } : {}),
      ...(list(option(args, 'android')) ? { android: list(option(args, 'android')) } : {}),
      ...(list(option(args, 'web')) ? { web: list(option(args, 'web')) } : {}),
      server: args.includes('--server'),
      expires,
    };
    console.log(signKey(payload, readFileSync(option(args, 'private-key'), 'utf8')));
  } else {
    console.error('usage: issue.mjs keygen --out <dir> | sign --private-key <pem> ...');
    process.exit(2);
  }
}
