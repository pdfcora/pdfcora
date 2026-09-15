# Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offline license keys that unlock feature modules; without a covering key the SDK still works but watermarks rendered pages, saved files and AI output.

**Architecture:** One license state per process on each platform verifies an ECDSA P-256 key against an embedded public key and reports `licensed(modules)` or `trial(reason)`. Each document carries a "needs watermark" flag, set at open in trial mode or by a gate at every paid entry point. Render overlays a watermark page drawn by PDFium; save stamps the watermark into a full-save copy; unlicensed signing signs a stamped copy.

**Tech Stack:** Swift 5.9 / CryptoKit (iOS 15), Kotlin 1.9 / `java.security` + JNI C++ (Android minSdk 23), TypeScript / WebCrypto + PDFium WASM (web), Node `crypto` (tooling).

**Spec:** `docs/superpowers/specs/2026-09-15-licensing-design.md`

## Global Constraints

- Key format: `pk1.<base64url payload>.<base64url signature>`, no padding. Signature: ECDSA P-256, SHA-256, raw 64-byte `r‖s`, over the **decoded payload bytes** (the UTF-8 JSON).
- Public key: 65-byte uncompressed point (`0x04‖x‖y`), stored as base64url text, identical on all platforms.
- Modules: `editing`, `forms`, `signing`, `redaction`, `ai`. `core` is implicit and never listed. Unknown names are ignored.
- Check order and reason codes: `noKey`, `malformed`, `badSignature`, `unsupportedVersion` (`v` ≠ 1), `revoked`, `expired` (release date > `expires`), `wrongApp`.
- Binding: iOS bundle ID ∈ `ios`; Android package ∈ `android`; web hostname matches `web` (exact or `*.suffix`, case-insensitive, wildcard never matches the bare suffix); Node (no hostname) needs `server: true`. A missing list means not covered.
- Watermark: text `PdfiumKit trial`, font `Helvetica-Bold`, fill RGB 128,128,128 alpha 64, diagonal bottom-left to top-right, text width 60% of the diagonal, centred.
- AI prefix: `PdfiumKit trial — ` (with the em dash and trailing space), on answer text and summary text only.
- A watermarked save is always a full save (`FPDF_NO_INCREMENTAL` = 2).
- Setting a key never throws. The first watermark in a process logs one warning.
- Test hooks must not be public API: `@testable`/`internal` on iOS, `internal` on Android, an unexported module on web.
- Test fixture constants: release date `2026-09-15`, revoked ids `["lic_revoked"]`, test app id `com.example.app`, default test host `app.example.com`.
- Every command runs from `/Users/daos/Projects/Lab/PdfiumKit-v2`.

---

## File map

| File | Responsibility |
| --- | --- |
| `tools/license/issue.mjs` | `keygen` and `sign` CLI; exports `generateKeyPair`, `signKey` |
| `tools/license/issue.test.mjs` | Round-trip test of the tool |
| `conformance/license/test-private.pem` | Test-only private key (committed) |
| `conformance/license/make-cases.mjs` | Generates `cases.json` |
| `conformance/license/cases.json` | Shared cases + `publicKey` + `fullKey` |
| `conformance/license/partial-keys.json` | Keys for `[]`, `[forms]`, `[editing]`, for behaviour tests |
| `web/src/license/key.ts` | Parse, verify, evaluate a key against a context |
| `web/src/license/state.ts` | Process state, `PdfLicense`, test hook, one-time warning |
| `web/src/license/watermark.ts` | `drawWatermark`, `stampWatermark` |
| `web/src/save.ts` | `saveHandle` shared by `toBytes` and stamping |
| `web/test/license-setup.ts` | Installs the full test key for every web test process |
| `web/test/license.test.ts` | Conformance cases |
| `web/test/license-watermark.test.ts` | Behaviour tests |
| `ios/Sources/PdfiumKit/License/LicenseKey.swift` | Parse, verify, evaluate |
| `ios/Sources/PdfiumKit/License/PdfLicense.swift` | Public API, state, test hook, warning |
| `ios/Sources/PdfiumKit/License/Watermark.swift` | Draw and stamp |
| `ios/Tests/PdfiumKitTests/LicensedTestCase.swift` | Base class installing the full test key |
| `ios/Tests/PdfiumKitTests/LicenseTests.swift` | Conformance + behaviour tests |
| `android/pdfiumkit/src/main/java/com/pdfiumkit/license/LicenseKey.kt` | Parse, verify, evaluate |
| `android/pdfiumkit/src/main/java/com/pdfiumkit/license/PdfLicense.kt` | Public API, state, test hook, warning |
| `android/pdfiumkit/src/main/cpp/watermark.cpp` | Draw and stamp in C++ |
| `android/pdfiumkit/src/androidTest/java/com/pdfiumkit/LicensedTestRunner.kt` | Runner installing the full test key |
| `android/pdfiumkit/src/androidTest/java/com/pdfiumkit/LicenseTest.kt` | Conformance + behaviour tests |
| `scripts/set-release-date.sh` | Writes the release date into all three platforms |

---

### Task 1: Key tool and shared fixtures

**Files:**
- Create: `tools/license/issue.mjs`, `tools/license/issue.test.mjs`, `conformance/license/make-cases.mjs`, `conformance/license/test-private.pem`, `conformance/license/cases.json`, `conformance/license/partial-keys.json`

**Interfaces:**
- Produces: `generateKeyPair(): { privateKeyPem: string, publicKey: string }` (publicKey base64url of 65 bytes); `signKey(payload: object, privateKeyPem: string): string`; `cases.json` shaped as below.

```json
{
  "publicKey": "<base64url>",
  "releaseDate": "2026-09-15",
  "revoked": ["lic_revoked"],
  "app": "com.example.app",
  "fullKey": "pk1....",
  "cases": [
    { "name": "valid", "key": "pk1...", "host": "app.example.com",
      "expected": {
        "ios":     { "kind": "licensed", "modules": ["editing", "signing"] },
        "android": { "kind": "licensed", "modules": ["editing", "signing"] },
        "web":     { "kind": "licensed", "modules": ["editing", "signing"] } } }
  ]
}
```

`key` is `null` for the no-key case. `host` is `null` for a Node context. Trial expectations are `{ "kind": "trial", "reason": "<code>" }`.

- [ ] **Step 1: Write the failing tool test**

`tools/license/issue.test.mjs`:
```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tools/license/issue.test.mjs`
Expected: FAIL, `Cannot find module .../issue.mjs`.

- [ ] **Step 3: Write the tool**

`tools/license/issue.mjs`:
```js
#!/usr/bin/env node
/**
 * Issues PdfiumKit license keys.
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
```

- [ ] **Step 4: Run the tool test to verify it passes**

Run: `node --test tools/license/issue.test.mjs`
Expected: PASS, 1 test.

- [ ] **Step 5: Write the case generator**

`conformance/license/make-cases.mjs`:
```js
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
```

Expected modules are listed sorted; every platform compares sorted arrays.

- [ ] **Step 6: Generate and commit**

Run: `node conformance/license/make-cases.mjs && node --test tools/license/issue.test.mjs`
Expected: `wrote 21 cases`, test PASS, `conformance/license/test-private.pem`, `cases.json` and `partial-keys.json` exist.

```bash
git add tools/license conformance/license
git commit -m "License key tool and shared license cases"
```

---

### Task 2: Web license state and conformance

**Files:**
- Create: `web/src/license/key.ts`, `web/src/license/state.ts`, `web/test/license.test.ts`
- Modify: `web/src/index.ts` (export `PdfLicense` and types)

**Interfaces:**
- Consumes: `conformance/license/cases.json` (Task 1).
- Produces:
  - `type PdfLicenseModule = 'editing' | 'forms' | 'signing' | 'redaction' | 'ai'`
  - `type PdfLicenseReason = 'noKey' | 'malformed' | 'badSignature' | 'unsupportedVersion' | 'revoked' | 'expired' | 'wrongApp'`
  - `type PdfLicenseStatus = { kind: 'licensed'; customer: string; modules: PdfLicenseModule[] } | { kind: 'trial'; reason: PdfLicenseReason; message: string }`
  - `PdfLicense.setKey(key: string): Promise<PdfLicenseStatus>`, `PdfLicense.status: PdfLicenseStatus`, `PdfLicense.covers(module): boolean`
  - internal (not exported from index): `licenseReady(): Promise<PdfLicenseStatus>`, `noteWatermark(detail: string): void`, `configureLicenseForTesting(options: { publicKey?: string; revoked?: string[]; releaseDate?: string; host?: string | null; key?: string | null }): Promise<PdfLicenseStatus>`, `currentKey(): string | null`, `setKeyForHost(key: string | null, host: string | null): Promise<PdfLicenseStatus>`

- [ ] **Step 1: Write the failing conformance test**

`web/test/license.test.ts`:
```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configureLicenseForTesting } from '../dist/license/state.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));

describe('license cases', () => {
  for (const c of FIXTURE.cases) {
    test(c.name, async () => {
      const status = await configureLicenseForTesting({
        publicKey: FIXTURE.publicKey, revoked: FIXTURE.revoked, releaseDate: FIXTURE.releaseDate,
        host: c.host, key: c.key,
      });
      const expected = c.expected.web;
      assert.equal(status.kind, expected.kind, JSON.stringify(status));
      if (status.kind === 'licensed') assert.deepEqual([...status.modules].sort(), expected.modules);
      else assert.equal(status.reason, expected.reason, status.message);
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm run build && npm run build:test`
Expected: FAIL, `Cannot find module '../dist/license/state.js'` (tsc error TS2307).

- [ ] **Step 3: Write `web/src/license/key.ts`**

```ts
/**
 * License keys: `pk1.<payload>.<signature>`, verified offline against an embedded
 * public key. See docs/superpowers/specs/2026-09-15-licensing-design.md.
 */

export type PdfLicenseModule = 'editing' | 'forms' | 'signing' | 'redaction' | 'ai';
export type PdfLicenseReason =
  | 'noKey' | 'malformed' | 'badSignature' | 'unsupportedVersion' | 'revoked' | 'expired' | 'wrongApp';
export type PdfLicenseStatus =
  | { readonly kind: 'licensed'; readonly customer: string; readonly modules: readonly PdfLicenseModule[] }
  | { readonly kind: 'trial'; readonly reason: PdfLicenseReason; readonly message: string };

export const MODULES: readonly PdfLicenseModule[] = ['editing', 'forms', 'signing', 'redaction', 'ai'];

export interface LicenseContext {
  readonly publicKey: string;
  readonly revoked: readonly string[];
  readonly releaseDate: string;
  /** The page's hostname, or null where there is none (Node). */
  readonly host: string | null;
}

interface Payload {
  v: number; id: string; customer: string; modules: string[];
  ios?: string[]; android?: string[]; web?: string[]; server?: boolean; expires: string;
}

const trial = (reason: PdfLicenseReason, message: string): PdfLicenseStatus => ({ kind: 'trial', reason, message });

function base64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url');
  const standard = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(standard + '==='.slice((standard.length + 3) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function parsePayload(bytes: Uint8Array): Payload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const p = value as Record<string, unknown>;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined;
  if (typeof p.v !== 'number' || typeof p.id !== 'string' || typeof p.customer !== 'string') return undefined;
  if (!strings(p.modules) || typeof p.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.expires)) return undefined;
  for (const list of ['ios', 'android', 'web'] as const) {
    if (p[list] !== undefined && !strings(p[list])) return undefined;
  }
  if (p.server !== undefined && typeof p.server !== 'boolean') return undefined;
  return p as unknown as Payload;
}

export function hostMatches(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : p === h;
}

export async function evaluateKey(key: string | null, context: LicenseContext): Promise<PdfLicenseStatus> {
  if (key === null || key.trim() === '') return trial('noKey', 'no license key set');

  const parts = key.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'pk1') return trial('malformed', 'license key is malformed');
  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    payloadBytes = base64url(parts[1]);
    signature = base64url(parts[2]);
  } catch {
    return trial('malformed', 'license key is malformed');
  }
  const payload = parsePayload(payloadBytes);
  if (!payload) return trial('malformed', 'license key is malformed');

  let verified = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw', base64url(context.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    verified = signature.length === 64 && await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, payloadBytes);
  } catch {
    verified = false;
  }
  if (!verified) return trial('badSignature', 'license key signature is invalid');

  if (payload.v !== 1) return trial('unsupportedVersion', `license key version ${payload.v} is not supported by this SDK`);
  if (context.revoked.includes(payload.id)) return trial('revoked', `license key ${payload.id} has been revoked`);
  if (context.releaseDate > payload.expires) {
    return trial('expired', `license key expired on ${payload.expires}, before this SDK was released on ${context.releaseDate}`);
  }

  if (context.host === null) {
    if (payload.server !== true) return trial('wrongApp', 'license key does not allow server use');
  } else if (!(payload.web ?? []).some((pattern) => hostMatches(pattern, context.host!))) {
    return trial('wrongApp', `key is for ${(payload.web ?? []).join(', ') || 'no web hosts'}, this page is ${context.host}`);
  }

  const modules = MODULES.filter((m) => payload.modules.includes(m));
  return { kind: 'licensed', customer: payload.customer, modules };
}
```

- [ ] **Step 4: Write `web/src/license/state.ts`**

```ts
import { evaluateKey, type LicenseContext, type PdfLicenseModule, type PdfLicenseStatus } from './key.js';
import { LICENSE_PUBLIC_KEY, RELEASE_DATE, REVOKED } from './build.js';

const hostOfThisContext = (): string | null =>
  typeof location === 'undefined' ? null : location.hostname;

let context: LicenseContext = {
  publicKey: LICENSE_PUBLIC_KEY, revoked: REVOKED, releaseDate: RELEASE_DATE, host: hostOfThisContext(),
};
let key: string | null = null;
let status: PdfLicenseStatus = { kind: 'trial', reason: 'noKey', message: 'no license key set' };
let pending: Promise<PdfLicenseStatus> = Promise.resolve(status);
let warned = false;

function evaluate(): Promise<PdfLicenseStatus> {
  const settled = evaluateKey(key, context).then((result) => {
    if (pending === settled) status = result;
    return result;
  });
  pending = settled;
  return settled;
}

export const PdfLicense = {
  /**
   * Sets the license key. Call before opening documents or creating a `PdfWorker`.
   * Never rejects: a bad key resolves to a trial status that says why.
   */
  setKey(value: string): Promise<PdfLicenseStatus> {
    key = value;
    return evaluate();
  },
  /** The result of the last settled check. */
  get status(): PdfLicenseStatus {
    return status;
  },
  covers(module: PdfLicenseModule): boolean {
    return status.kind === 'licensed' && status.modules.includes(module);
  },
};

/** @internal Awaited before a document opens, so a key set just before counts. */
export function licenseReady(): Promise<PdfLicenseStatus> {
  return pending;
}

/** @internal */
export function currentKey(): string | null {
  return key;
}

/** @internal Used by the worker host: the check must use the page's hostname. */
export function setKeyForHost(value: string | null, host: string | null): Promise<PdfLicenseStatus> {
  key = value;
  context = { ...context, host };
  return evaluate();
}

/** @internal Logs once per process, the first time anything is watermarked. */
export function noteWatermark(detail: string): void {
  if (warned) return;
  warned = true;
  console.warn(`PdfiumKit: output is watermarked — ${detail}`);
}

/** @internal Test hook. Not exported from the package entry point. */
export function configureLicenseForTesting(options: {
  publicKey?: string; revoked?: string[]; releaseDate?: string; host?: string | null; key?: string | null;
}): Promise<PdfLicenseStatus> {
  context = {
    publicKey: options.publicKey ?? context.publicKey,
    revoked: options.revoked ?? context.revoked,
    releaseDate: options.releaseDate ?? context.releaseDate,
    host: options.host === undefined ? context.host : options.host,
  };
  if (options.key !== undefined) key = options.key;
  return evaluate();
}
```

`web/src/license/build.ts` (rewritten by `scripts/set-release-date.sh` and Task 12):
```ts
/** Set at release. The public key's private half is held outside this repository. */
export const RELEASE_DATE = '2026-09-15';
export const LICENSE_PUBLIC_KEY = 'REPLACED_IN_TASK_12';
export const REVOKED: readonly string[] = [];
```
Task 12 replaces `LICENSE_PUBLIC_KEY` with the production key. Until then the value fails `importKey`, so every real key is `badSignature` and tests use the hook.

- [ ] **Step 5: Export from the package**

Append to `web/src/index.ts`:
```ts
export { PdfLicense } from './license/state.js';
export type { PdfLicenseModule, PdfLicenseReason, PdfLicenseStatus } from './license/key.js';
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd web && npm run build && npm run build:test && node --test dist-test/license.test.js`
Expected: PASS, 21 tests.

- [ ] **Step 7: Commit**

```bash
git add web/src/license web/src/index.ts web/test/license.test.ts
git commit -m "Web: license keys, verified offline"
```

---

### Task 3: Web watermark, marking and gates

**Files:**
- Create: `web/src/save.ts`, `web/src/license/watermark.ts`, `web/test/license-setup.ts`, `web/test/license-watermark.test.ts`
- Modify: `web/src/document.ts` (open, `use`, `toBytes`, `setRotation`, `redact`, `sign`), `web/src/page.ts` (`render`, `addInk`, `addHighlight`, `addUnderline`, `addStrikeout`, `addNote`, `removeAnnotation`, `setText`, `setChecked`, `setOption`), `web/package.json` (test script)

**Interfaces:**
- Consumes: `licenseReady`, `noteWatermark`, `PdfLicense`, `configureLicenseForTesting` (Task 2).
- Produces:
  - `saveHandle(m: PdfiumModule, handle: number, flag: 1 | 2): Uint8Array`
  - `drawWatermark(m: PdfiumModule, bitmap: number, width: number, height: number): void`
  - `stampWatermark(m: PdfiumModule, bytes: Uint8Array): Uint8Array`
  - `PdfDocument.use(module: PdfLicenseModule): void` (@internal), `PdfDocument.needsWatermark: boolean` (@internal getter)

- [ ] **Step 1: Install the full test key for every existing test**

`web/test/license-setup.ts`:
```ts
import { readFileSync } from 'node:fs';
import { configureLicenseForTesting } from '../dist/license/state.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));

// Every test process runs licensed for every module; license tests change this locally.
await configureLicenseForTesting({
  publicKey: FIXTURE.publicKey, revoked: FIXTURE.revoked, releaseDate: FIXTURE.releaseDate,
  host: null, key: FIXTURE.fullKey,
});
```

In `web/package.json` change the `test` script to:
```json
"test": "npm run build && npm run build:test && node --import ./dist-test/license-setup.js --test \"dist-test/*.test.js\""
```

Run: `cd web && npm test 2>&1 | tail -5`
Expected: all 248 existing tests plus 21 license tests pass. If the runner does not pass `--import` to its child processes (check: add `console.error(await (await import('../dist/license/state.js')).PdfLicense.status.kind)` temporarily to one test and look for `licensed`), use `node --test --test-isolation=none --import ./dist-test/license-setup.js …` instead.

- [ ] **Step 2: Write the failing behaviour tests**

`web/test/license-watermark.test.ts`:
```ts
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfDocument } from '../dist/index.js';
import type { CmsSigner } from '../dist/index.js';
import { configureLicenseForTesting } from '../dist/license/state.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURE = JSON.parse(readFileSync(`${ROOT}conformance/license/cases.json`, 'utf8'));
const PARTIAL = JSON.parse(readFileSync(`${ROOT}conformance/license/partial-keys.json`, 'utf8'));
const read = (file: string) => new Uint8Array(readFileSync(`${ROOT}conformance/corpus/${file}`));
const MARK = 'PdfiumKit trial';

const useKey = (key: string | null) => configureLicenseForTesting({ key, host: null });
const keyWith = (modules: string[]): string => PARTIAL[modules.join(',')];

afterEach(() => useKey(FIXTURE.fullKey));

/** Grey pixels the white hello_world page does not otherwise contain. */
function greyPixels(data: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r < 250 && Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && r > 150) count++;
  }
  return count;
}

async function textOfEveryPage(bytes: Uint8Array): Promise<string[]> {
  const document = await PdfDocument.open(bytes);
  const texts: string[] = [];
  for (let i = 0; i < await document.pageCount(); i++) texts.push(await (await document.page(i)).text.string());
  await document.close();
  return texts;
}

describe('watermark', () => {
  test('trial render is watermarked; licensed render is not', async () => {
    await useKey(FIXTURE.fullKey);
    const licensed = await (await (await PdfDocument.open(read('hello_world.pdf'))).page(0)).render({ width: 400 });
    await useKey(null);
    const trial = await (await (await PdfDocument.open(read('hello_world.pdf'))).page(0)).render({ width: 400 });
    assert.ok(greyPixels(trial.data) > greyPixels(licensed.data) + 500,
      `trial ${greyPixels(trial.data)} vs licensed ${greyPixels(licensed.data)}`);
  });

  test('trial save carries the watermark on every page; licensed save does not', async () => {
    await useKey(null);
    const trialBytes = await (await PdfDocument.open(read('rectangles_multi_pages.pdf'))).toBytes();
    for (const text of await textOfEveryPage(trialBytes)) assert.ok(text.includes(MARK));
    await useKey(FIXTURE.fullKey);
    const licensedBytes = await (await PdfDocument.open(read('rectangles_multi_pages.pdf'))).toBytes();
    for (const text of await textOfEveryPage(licensedBytes)) assert.ok(!text.includes(MARK));
  });

  test('saving twice stamps once each time', async () => {
    await useKey(null);
    const document = await PdfDocument.open(read('hello_world.pdf'));
    await document.toBytes();
    const [text] = await textOfEveryPage(await document.toBytes());
    assert.equal(text!.split(MARK).length - 1, 1);
  });

  test('an incremental save of a marked document comes back full and watermarked', async () => {
    await useKey(null);
    const original = read('hello_world.pdf');
    const bytes = await (await PdfDocument.open(original)).toBytes('incremental');
    assert.notDeepEqual(bytes.subarray(0, original.length), original);
    assert.ok((await textOfEveryPage(bytes))[0]!.includes(MARK));
  });

  test('an unlicensed module marks the document; a licensed one does not', async () => {
    await useKey(keyWith(['forms']));
    const document = await PdfDocument.open(read('hello_world.pdf'));
    assert.equal(document.needsWatermark, false);
    await (await document.page(0)).addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'x');
    assert.equal(document.needsWatermark, true);

    await useKey(keyWith(['editing']));
    const licensed = await PdfDocument.open(read('hello_world.pdf'));
    await (await licensed.page(0)).addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'x');
    assert.equal(licensed.needsWatermark, false);
  });

  test('unlicensed redaction still removes the text', async () => {
    await useKey(keyWith([]));
    const document = await PdfDocument.open(read('hello_world.pdf'));
    await document.redact([{ kind: 'textMatches', query: 'Hello' }]);
    const [text] = await textOfEveryPage(await document.toBytes());
    assert.ok(!text!.includes('Hello'));
    assert.ok(text!.includes(MARK));
  });

  test('unlicensed signing verifies in pdfsig and contains the watermark', async () => {
    await useKey(keyWith([]));
    const scratch = mkdtempSync(join(tmpdir(), 'pdfiumkit-license-'));
    const FIXTURES = `${ROOT}conformance/fixtures/`;
    const signer: CmsSigner = {
      async sign(data) {
        const input = join(scratch, 'data.bin');
        writeFileSync(input, data);
        execFileSync('openssl', ['cms', '-sign', '-binary', '-nosmimecap', '-cades', '-md', 'sha256',
          '-signer', `${FIXTURES}test-signer-cert.pem`, '-inkey', `${FIXTURES}test-signer-key.pem`,
          '-outform', 'DER', '-in', input, '-out', `${input}.der`]);
        return new Uint8Array(readFileSync(`${input}.der`));
      },
    };
    const signed = await (await PdfDocument.open(read('hello_world.pdf'))).sign({ signer });
    assert.ok((await textOfEveryPage(signed))[0]!.includes(MARK));
    const path = join(scratch, 'signed.pdf');
    writeFileSync(path, signed);
    let report = '';
    try { report = execFileSync('pdfsig', [path], { encoding: 'utf8' }); }
    catch (error) { report = String((error as { stdout?: string }).stdout ?? ''); }
    assert.match(report, /Signature is Valid/);
    assert.match(report, /Total document signed/);
  });
});
```

Before relying on them, confirm the corpus files exist: `ls conformance/corpus/hello_world.pdf conformance/corpus/rectangles_multi_pages.pdf`. If `rectangles_multi_pages.pdf` is absent, use any corpus file with two or more pages (`grep -l` the expectations file for `"pageCount": 2`).

- [ ] **Step 3: Run to verify they fail**

Run: `cd web && npm run build && npm run build:test && node --import ./dist-test/license-setup.js --test dist-test/license-watermark.test.js`
Expected: FAIL on build, `Property 'needsWatermark' does not exist on type 'PdfDocument'`.

- [ ] **Step 4: Extract `web/src/save.ts`**

```ts
import { withBuffer, type PdfiumModule } from './engine.js';
import { PdfError } from './errors.js';

/** Serialises a document handle. `flag` is FPDF_INCREMENTAL (1) or FPDF_NO_INCREMENTAL (2). */
export function saveHandle(m: PdfiumModule, handle: number, flag: 1 | 2): Uint8Array {
  const chunks: Uint8Array[] = [];
  // FPDF_FILEWRITE is { version, WriteBlock }; the callback receives that pointer.
  const anyModule = m as unknown as {
    addFunction(fn: (...args: number[]) => number, signature: string): number;
    removeFunction(ptr: number): void;
  };
  const callback = anyModule.addFunction((_fw: number, data: number, size: number) => {
    chunks.push(m.HEAPU8.slice(data, data + size));
    return 1;
  }, 'iiii');

  try {
    return withBuffer(m, 8, (writer) => {
      new Int32Array(m.HEAPU8.buffer, writer, 2).set([1, callback]);
      const ok = m.ccall('FPDF_SaveAsCopy', 'number', ['number', 'number', 'number'], [handle, writer, flag]) as number;
      if (!ok) throw PdfError.saveFailed('PDFium refused to serialise the document');

      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      if (total === 0) throw PdfError.saveFailed('no bytes were produced');
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    });
  } finally {
    anyModule.removeFunction(callback);
  }
}
```

- [ ] **Step 5: Write `web/src/license/watermark.ts`**

```ts
import { withBuffer, withUtf16, type PdfiumModule } from '../engine.js';
import { PdfError } from '../errors.js';
import { saveHandle } from '../save.js';

const TEXT = 'PdfiumKit trial';

/** Adds the watermark to `page`, centred on the box and running along its diagonal. */
function placeWatermark(m: PdfiumModule, document: number, page: number,
                        left: number, bottom: number, width: number, height: number): void {
  const text = m.ccall('FPDFPageObj_NewTextObj', 'number', ['number', 'string', 'number'],
    [document, 'Helvetica-Bold', 100]) as number;
  if (!text) return;
  withUtf16(m, TEXT, (ptr) => m.ccall('FPDFText_SetText', 'number', ['number', 'number'], [text, ptr]));
  m.ccall('FPDFPageObj_SetFillColor', 'number', ['number', 'number', 'number', 'number', 'number'],
    [text, 128, 128, 128, 64]);

  const [l, b, r, t] = withBuffer(m, 16, (ptr) => {
    m.ccall('FPDFPageObj_GetBounds', 'number', ['number', 'number', 'number', 'number', 'number'],
      [text, ptr, ptr + 4, ptr + 8, ptr + 12]);
    return Array.from(new Float32Array(m.HEAPU8.buffer, ptr, 4));
  });
  const angle = Math.atan2(height, width);
  const scale = (Math.hypot(width, height) * 0.6) / Math.max(1, r! - l!);
  const [cos, sin] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
  const matrix = ['number', 'number', 'number', 'number', 'number', 'number', 'number'];
  m.ccall('FPDFPageObj_Transform', null, matrix, [text, 1, 0, 0, 1, -(l! + r!) / 2, -(b! + t!) / 2]);
  m.ccall('FPDFPageObj_Transform', null, matrix, [text, cos, sin, -sin, cos, left + width / 2, bottom + height / 2]);
  m.ccall('FPDFPage_InsertObject', null, ['number', 'number'], [page, text]);
  m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
}

/** Draws the watermark over an already rendered bitmap, leaving the document untouched. */
export function drawWatermark(m: PdfiumModule, bitmap: number, width: number, height: number): void {
  const scratch = m.ccall('FPDF_CreateNewDocument', 'number', [], []) as number;
  if (!scratch) return;
  try {
    const page = m.ccall('FPDFPage_New', 'number', ['number', 'number', 'number', 'number'],
      [scratch, 0, width, height]) as number;
    if (!page) return;
    placeWatermark(m, scratch, page, 0, 0, width, height);
    m.ccall('FPDF_RenderPageBitmap', null,
      ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      [bitmap, page, 0, 0, width, height, 0, 0]);
    m.ccall('FPDF_ClosePage', null, ['number'], [page]);
  } finally {
    m.ccall('FPDF_CloseDocument', null, ['number'], [scratch]);
  }
}

/** Returns a full save of `bytes` with the watermark in every page's content. */
export function stampWatermark(m: PdfiumModule, bytes: Uint8Array): Uint8Array {
  const buffer = m._malloc(bytes.length);
  m.HEAPU8.set(bytes, buffer);
  const document = m.ccall('FPDF_LoadMemDocument', 'number', ['number', 'number', 'string'],
    [buffer, bytes.length, null]) as number;
  if (!document) {
    m._free(buffer);
    throw PdfError.saveFailed('the saved document could not be reopened to watermark it');
  }
  try {
    const count = m.ccall('FPDF_GetPageCount', 'number', ['number'], [document]) as number;
    for (let index = 0; index < count; index++) {
      const page = m.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [document, index]) as number;
      if (!page) continue;
      const box = withBuffer(m, 16, (ptr) => {
        const ok = m.ccall('FPDFPage_GetMediaBox', 'number', ['number', 'number', 'number', 'number', 'number'],
          [page, ptr, ptr + 4, ptr + 8, ptr + 12]) as number;
        return ok ? Array.from(new Float32Array(m.HEAPU8.buffer, ptr, 4)) : undefined;
      });
      const width = m.ccall('FPDF_GetPageWidthF', 'number', ['number'], [page]) as number;
      const height = m.ccall('FPDF_GetPageHeightF', 'number', ['number'], [page]) as number;
      const [left, bottom] = box ? [box[0]!, box[1]!] : [0, 0];
      placeWatermark(m, document, page, left, bottom, width, height);
      m.ccall('FPDF_ClosePage', null, ['number'], [page]);
    }
    return saveHandle(m, document, 2);
  } finally {
    m.ccall('FPDF_CloseDocument', null, ['number'], [document]);
    m._free(buffer);
  }
}
```

Check that `FPDF_GetPageWidthF`/`FPDF_GetPageHeightF` are exported: `grep -c _FPDF_GetPageWidthF web/vendor/pdfium.js` (or `vendor/web/pdfium.js`). If not, use `FPDF_GetPageWidth`/`FPDF_GetPageHeight`.

- [ ] **Step 6: Mark documents and gate the paid entry points**

In `web/src/document.ts`:

1. Add imports:
```ts
import { licenseReady, noteWatermark, PdfLicense } from './license/state.js';
import type { PdfLicenseModule } from './license/key.js';
import { drawWatermark, stampWatermark } from './license/watermark.js';
import { saveHandle } from './save.js';
```
2. Add fields after `private closedFlag = false;`:
```ts
  private marked = false;
```
3. In `open`, first line after `const m = await engine();`, add:
```ts
    const license = await licenseReady();
```
and change the final `return new PdfDocument(m, handle, ptr, bytes);` to:
```ts
    const document = new PdfDocument(m, handle, ptr, bytes);
    document.marked = license.kind === 'trial';
    return document;
```
4. Add methods after `get isClosed()`:
```ts
  /** @internal True once anything this document produces must carry the watermark. */
  get needsWatermark(): boolean {
    return this.marked;
  }

  /** @internal Every paid entry point calls this first. The operation runs either way. */
  use(module: PdfLicenseModule): void {
    if (!PdfLicense.covers(module)) this.marked = true;
  }

  /** @internal Called whenever watermarked output is produced. */
  noteWatermarked(): void {
    const status = PdfLicense.status;
    noteWatermark(status.kind === 'trial' ? status.message : 'the license key does not cover every module used');
  }
```
5. In `setRotation`, add `this.use('editing');` as the first statement.
6. In `redact`, add `this.use('redaction');` as the first statement.
7. Replace the body of `sign`:
```ts
  async sign(options: PdfSignOptions): Promise<Uint8Array> {
    this.use('signing');
    if (!this.marked) return signDocument(this.originalBytes, options);
    this.noteWatermarked();
    const stamped = await this.run((_, m) => stampWatermark(m, this.originalBytes));
    return signDocument(stamped, options);
  }
```
8. Replace the body of `toBytes`:
```ts
  toBytes(mode: PdfSaveMode = 'full'): Promise<Uint8Array> {
    return this.run((h, m) => {
      if (!this.marked) return saveHandle(m, h, mode === 'incremental' ? 1 : 2);
      this.noteWatermarked();
      return stampWatermark(m, saveHandle(m, h, 2));
    });
  }
```
9. Add an internal helper used by `page.ts`:
```ts
  /** @internal Draws the watermark when this document needs it. */
  watermarkBitmap(m: PdfiumModule, bitmap: number, width: number, height: number): void {
    if (!this.marked) return;
    this.noteWatermarked();
    drawWatermark(m, bitmap, width, height);
  }
```

Update the doc comments on `toBytes` and `sign` to add: "A document that needs the watermark is always saved in full."

In `web/src/page.ts`:
- In `render`, directly after the `if (options.forms !== false) { … }` block and before `const buffer = …`, add:
```ts
        this.document.watermarkBitmap(m, bitmap, width, height);
```
- Add `this.document.use('editing');` as the first statement of `addInk`, `addHighlight`, `addUnderline`, `addStrikeout`, `addNote` and `removeAnnotation`.
- Add `this.document.use('forms');` as the first statement of `setText`, `setChecked` and `setOption`.

If `addHighlight`, `addUnderline` and `addStrikeout` all delegate to one private helper, put the `use('editing')` call in that helper instead, once.

- [ ] **Step 7: Run the behaviour tests**

Run: `cd web && npm run build && npm run build:test && node --import ./dist-test/license-setup.js --test dist-test/license-watermark.test.js`
Expected: PASS, 7 tests. If the render test fails, print `greyPixels` for both images and save the trial render as a PPM to look at it; adjust the grey classification, not the watermark colour.

- [ ] **Step 8: Run the whole web suite**

Run: `cd web && npm test 2>&1 | tail -8`
Expected: every test passes (248 existing + 21 + 7).

- [ ] **Step 9: Commit**

```bash
git add web/src web/test web/package.json
git commit -m "Web: watermark rendering, saving and signing without a covering license"
```

---

### Task 4: Web worker forwards the key

**Files:**
- Modify: `web/src/worker/protocol.ts`, `web/src/worker/client.ts`, `web/src/worker/host.ts`
- Test: `web/test/worker-watchdog.test.ts` is the existing worker test; add `web/test/license-worker.test.ts`

**Interfaces:**
- Consumes: `currentKey()`, `setKeyForHost()` (Task 2).
- Produces: `InitRequest.license?: { key: string | null; host: string | null }`.

- [ ] **Step 1: Read how the existing worker test starts a worker in Node**

Run: `sed -n 1,60p web/test/worker-watchdog.test.ts`
Use the same construction (worker URL, glue and wasm URLs) in the new test.

- [ ] **Step 2: Write the failing test**

`web/test/license-worker.test.ts`, using the construction found in Step 1 (shown here with the names that test uses; match them exactly):
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfWorker } from '../dist/index.js';
import { configureLicenseForTesting } from '../dist/license/state.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const MARK = 'PdfiumKit trial';

test('a worker in trial mode watermarks what it saves', async () => {
  await configureLicenseForTesting({ key: null, host: null });
  const worker = new PdfWorker(/* options exactly as in worker-watchdog.test.ts */);
  try {
    const document = await worker.open(new Uint8Array(readFileSync(`${ROOT}conformance/corpus/hello_world.pdf`)));
    const bytes = await document.toBytes();
    assert.ok(Buffer.from(bytes).includes(Buffer.from('Helvetica-Bold')), 'the stamped font must be in the file');
  } finally {
    worker.terminate();
  }
});
```

If `PdfWorker` cannot run under Node in this repo (the existing test uses a shim), follow that shim. If there is no Node worker test at all, test the host function directly instead: import the host's message handler and assert that after an `init` request carrying `license: { key: null, host: null }`, `PdfLicense.status.kind` in the host module is `trial`.

- [ ] **Step 3: Run to verify it fails**

Run: `cd web && npm run build && npm run build:test && node --import ./dist-test/license-setup.js --test dist-test/license-worker.test.js`
Expected: FAIL: the worker process never received the key, so it evaluates with its own defaults (build public key, `noKey`) — and with the full test key installed in the main process, the assertion direction depends on the worker's own state. Confirm the failure is about the missing key forwarding before implementing.

- [ ] **Step 4: Implement**

`web/src/worker/protocol.ts`, in `InitRequest` add:
```ts
  /** The main thread's key and hostname; the check runs here, against the page's host. */
  license?: { key: string | null; host: string | null };
```

`web/src/worker/client.ts`: import `currentKey` from `'../license/state.js'` and extend the init request:
```ts
    this.ready = this.send({
      op: 'init',
      glueUrl: String(options.glueUrl),
      wasmUrl: String(options.wasmUrl),
      license: { key: currentKey(), host: typeof location === 'undefined' ? null : location.hostname },
    }) as Promise<void>;
```

`web/src/worker/host.ts`: import `setKeyForHost` from `'../license/state.js'`; in `case 'init':` before `configureEngine({`, add:
```ts
        if (request.license) await setKeyForHost(request.license.key, request.license.host);
```
The test hook's public key also has to reach the worker in tests; if Step 3 showed the worker uses the build public key, extend `license` with `publicKey?: string; revoked?: string[]; releaseDate?: string`, send them only when `configureLicenseForTesting` has set them (export `testOverrides(): object | undefined` from `state.ts`, returning the overrides only after the hook ran), and apply them in the host through `configureLicenseForTesting`.

- [ ] **Step 5: Run the test and the full suite**

Run: `cd web && npm test 2>&1 | tail -5`
Expected: every test passes.

- [ ] **Step 6: Commit**

```bash
git add web/src/worker web/src/license web/test/license-worker.test.ts
git commit -m "Web: PdfWorker checks the license against the page's hostname"
```

---

### Task 5: web-ai trial prefix

**Files:**
- Modify: `web-ai/src/answers.ts:141-147`, `web-ai/src/index.ts` (summarize return), add `web-ai/src/trial.ts`
- Test: `web-ai/test/trial.test.ts` (match the existing web-ai test folder; run `ls web-ai` first)

**Interfaces:**
- Consumes: `PdfLicense.covers('ai')` from `@pdfiumkit/web`.
- Produces: `trialText(text: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialText, TRIAL_PREFIX } from '../dist/trial.js';

test('without an ai license the text is prefixed, and only once', () => {
  assert.equal(TRIAL_PREFIX, 'PdfiumKit trial — ');
  assert.equal(trialText('An answer.', false), 'PdfiumKit trial — An answer.');
  assert.equal(trialText('An answer.', true), 'An answer.');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-ai && npm test 2>&1 | tail -5`
Expected: FAIL, cannot find `../dist/trial.js`.

- [ ] **Step 3: Implement**

`web-ai/src/trial.ts`:
```ts
import { PdfLicense } from '@pdfiumkit/web';

export const TRIAL_PREFIX = 'PdfiumKit trial — ';
let warned = false;

/** Marks model output produced without an `ai` license. Quotes are never touched. */
export function trialText(text: string, licensed = PdfLicense.covers('ai')): string {
  if (licensed) return text;
  if (!warned) {
    warned = true;
    console.warn('PdfiumKit: AI output is marked as trial — the license key does not include the ai module');
  }
  return TRIAL_PREFIX + text;
}
```

In `web-ai/src/answers.ts`, import `trialText` and change `text: reply.answer,` to `text: trialText(reply.answer),`.

In `web-ai/src/index.ts`, import `trialText` and change every summary construction `{ text: await summariseInWindows(…), pagesWithoutText }` and the custom-provider equivalent to wrap the text: `{ text: trialText(await summariseInWindows(…)), pagesWithoutText }`. Find them with `grep -n "pagesWithoutText }" web-ai/src/index.ts`.

- [ ] **Step 4: Make the existing web-ai tests licensed**

web-ai tests compare answer and summary text. Add `web-ai/test/license-setup.ts` that installs the full key exactly as `web/test/license-setup.ts` does, importing `configureLicenseForTesting` from `'@pdfiumkit/web/dist/license/state.js'` if the package exports allow it, otherwise from the relative path web-ai already uses to reach the web build (check `grep -rn "pdfiumkit/web" web-ai/test | head -3`). Add `--import ./dist-test/license-setup.js` to web-ai's test script the same way.

- [ ] **Step 5: Run web-ai tests**

Run: `cd web-ai && npm test 2>&1 | tail -5`
Expected: 41 existing tests + 1 new pass.

- [ ] **Step 6: Commit**

```bash
git add web-ai
git commit -m "web-ai: mark answers and summaries without an ai license"
```

---

### Task 6: iOS license state and conformance

**Files:**
- Create: `ios/Sources/PdfiumKit/License/LicenseKey.swift`, `ios/Sources/PdfiumKit/License/PdfLicense.swift`, `ios/Tests/PdfiumKitTests/LicenseTests.swift`, `ios/Tests/PdfiumKitTests/LicensedTestCase.swift`, `ios/Tests/PdfiumKitAITests/LicensedTestCase.swift`
- Modify: every `ios/Tests/PdfiumKitTests/*.swift` and `ios/Tests/PdfiumKitAITests/*.swift` class declared `: XCTestCase` → `: LicensedTestCase`

**Interfaces:**
- Consumes: `cases.json` (Task 1).
- Produces:
  - `public enum PdfLicenseModule: String, CaseIterable, Sendable { case editing, forms, signing, redaction, ai }`
  - `public enum PdfLicenseReason: String, Sendable { case noKey, malformed, badSignature, unsupportedVersion, revoked, expired, wrongApp }`
  - `public enum PdfLicenseStatus: Sendable, Equatable { case licensed(customer: String, modules: Set<PdfLicenseModule>); case trial(reason: PdfLicenseReason, message: String); public func covers(_ module: PdfLicenseModule) -> Bool; public var isTrial: Bool }`
  - `public enum PdfLicense { public static func setKey(_ key: String); public static var status: PdfLicenseStatus }`
  - internal: `PdfLicense.configureForTesting(publicKey: String? = nil, revoked: Set<String>? = nil, releaseDate: String? = nil, appIdentifier: String? = nil, key: String?? = .none) -> PdfLicenseStatus`, `PdfLicense.noteWatermark(_ detail: String)`

- [ ] **Step 1: Write the failing conformance test**

`ios/Tests/PdfiumKitTests/LicenseTests.swift`:
```swift
import XCTest
@testable import PdfiumKit

struct LicenseFixture: Decodable {
    struct Expected: Decodable { let kind: String; let reason: String?; let modules: [String]? }
    struct Case: Decodable { let name: String; let key: String?; let expected: [String: Expected] }
    let publicKey: String
    let releaseDate: String
    let revoked: [String]
    let app: String
    let fullKey: String
    let cases: [Case]

    static func load() throws -> LicenseFixture {
        let url = Repo.root.appendingPathComponent("conformance/license/cases.json")
        return try JSONDecoder().decode(LicenseFixture.self, from: Data(contentsOf: url))
    }
}

final class LicenseTests: LicensedTestCase {
    func testSharedCases() throws {
        let fixture = try LicenseFixture.load()
        for c in fixture.cases {
            let status = PdfLicense.configureForTesting(
                publicKey: fixture.publicKey, revoked: Set(fixture.revoked),
                releaseDate: fixture.releaseDate, appIdentifier: fixture.app, key: .some(c.key))
            let expected = try XCTUnwrap(c.expected["ios"], c.name)
            switch status {
            case .licensed(_, let modules):
                XCTAssertEqual(expected.kind, "licensed", "\(c.name): \(status)")
                XCTAssertEqual(modules.map(\.rawValue).sorted(), expected.modules, c.name)
            case .trial(let reason, let message):
                XCTAssertEqual(expected.kind, "trial", "\(c.name): \(message)")
                XCTAssertEqual(reason.rawValue, expected.reason, "\(c.name): \(message)")
            }
        }
    }
}
```

`Repo` is defined in `ConformanceTests.swift` (`Repo.root`); reuse it.

`ios/Tests/PdfiumKitTests/LicensedTestCase.swift`:
```swift
import XCTest
@testable import PdfiumKit

/// Every suite runs licensed for every module. License tests change this locally and
/// restore it in `tearDown`.
class LicensedTestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        installFullTestLicense()
    }

    override func tearDown() {
        LicensedTestCase.installFullTestLicense()
        super.tearDown()
    }

    static func installFullTestLicense() {
        guard let fixture = try? LicenseFixture.load() else { return XCTFail("conformance/license/cases.json is missing") }
        _ = PdfLicense.configureForTesting(publicKey: fixture.publicKey, revoked: Set(fixture.revoked),
                                           releaseDate: fixture.releaseDate, appIdentifier: fixture.app,
                                           key: .some(fixture.fullKey))
    }
}
```

The AI test target cannot see `LicenseFixture` or `Repo`; its `LicensedTestCase.swift` inlines both:
```swift
import XCTest
@testable import PdfiumKit

class LicensedTestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/license/cases.json")
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let publicKey = json["publicKey"] as? String, let fullKey = json["fullKey"] as? String,
              let releaseDate = json["releaseDate"] as? String, let app = json["app"] as? String
        else { return XCTFail("conformance/license/cases.json is missing") }
        _ = PdfLicense.configureForTesting(publicKey: publicKey, revoked: [], releaseDate: releaseDate,
                                           appIdentifier: app, key: .some(fullKey))
    }
}
```
Check the path depth: `ios/Tests/PdfiumKitAITests/LicensedTestCase.swift` → four `deletingLastPathComponent()` reach the repo root. Compare with `Repo.root` in `ConformanceTests.swift`.

Switch every test class to the base class:
```bash
grep -rl ": XCTestCase" ios/Tests/PdfiumKitTests ios/Tests/PdfiumKitAITests \
  | grep -v LicensedTestCase.swift \
  | xargs sed -i '' 's/: XCTestCase/: LicensedTestCase/'
grep -rn "override func tearDown()" ios/Tests | head
```
Any existing `override func tearDown()` must call `super.tearDown()`; add the call where missing. Classes with `override class func setUp()` must call `super.setUp()`.

- [ ] **Step 2: Run to verify it fails**

Run: `xcodebuild test -scheme PdfiumKit-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PdfiumKitTests/LicenseTests 2>&1 | grep -E "error:|Test Suite|passed|failed" | head`
Expected: build error, `cannot find 'PdfLicense' in scope`.

- [ ] **Step 3: Write `ios/Sources/PdfiumKit/License/LicenseKey.swift`**

```swift
import CryptoKit
import Foundation

public enum PdfLicenseModule: String, CaseIterable, Sendable {
    case editing, forms, signing, redaction, ai
}

public enum PdfLicenseReason: String, Sendable {
    case noKey, malformed, badSignature, unsupportedVersion, revoked, expired, wrongApp
}

public enum PdfLicenseStatus: Sendable, Equatable {
    case licensed(customer: String, modules: Set<PdfLicenseModule>)
    case trial(reason: PdfLicenseReason, message: String)

    public func covers(_ module: PdfLicenseModule) -> Bool {
        if case .licensed(_, let modules) = self { return modules.contains(module) }
        return false
    }

    public var isTrial: Bool {
        if case .trial = self { return true }
        return false
    }
}

struct LicenseContext: Sendable {
    var publicKey: String
    var revoked: Set<String>
    var releaseDate: String
    var appIdentifier: String?
}

/// `pk1.<payload>.<signature>`, verified offline. See the licensing spec.
enum LicenseKey {
    static func evaluate(_ key: String?, context: LicenseContext) -> PdfLicenseStatus {
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else {
            return .trial(reason: .noKey, message: "no license key set")
        }
        let malformed = PdfLicenseStatus.trial(reason: .malformed, message: "license key is malformed")
        let parts = key.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0] == "pk1",
              let payloadBytes = base64url(parts[1]), let signatureBytes = base64url(parts[2]),
              let payload = Payload(payloadBytes)
        else { return malformed }

        guard let keyBytes = base64url(context.publicKey),
              let publicKey = try? P256.Signing.PublicKey(x963Representation: keyBytes),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signatureBytes),
              publicKey.isValidSignature(signature, for: payloadBytes)
        else { return .trial(reason: .badSignature, message: "license key signature is invalid") }

        guard payload.v == 1 else {
            return .trial(reason: .unsupportedVersion, message: "license key version \(payload.v) is not supported by this SDK")
        }
        guard !context.revoked.contains(payload.id) else {
            return .trial(reason: .revoked, message: "license key \(payload.id) has been revoked")
        }
        guard context.releaseDate <= payload.expires else {
            return .trial(reason: .expired, message:
                "license key expired on \(payload.expires), before this SDK was released on \(context.releaseDate)")
        }
        guard let app = context.appIdentifier, payload.ios.contains(app) else {
            let listed = payload.ios.isEmpty ? "no iOS apps" : payload.ios.joined(separator: ", ")
            return .trial(reason: .wrongApp, message: "key is for \(listed), this app is \(context.appIdentifier ?? "unknown")")
        }
        let modules = Set(payload.modules.compactMap(PdfLicenseModule.init(rawValue:)))
        return .licensed(customer: payload.customer, modules: modules)
    }

    static func base64url(_ text: String) -> Data? {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        switch standard.count % 4 {
        case 2: standard += "=="
        case 3: standard += "="
        case 1: return nil
        default: break
        }
        return Data(base64Encoded: standard)
    }

    private struct Payload {
        let v: Int
        let id: String
        let customer: String
        let modules: [String]
        let ios: [String]
        let expires: String

        init?(_ data: Data) {
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let v = object["v"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(),
                  let id = object["id"] as? String,
                  let customer = object["customer"] as? String,
                  let modules = object["modules"] as? [String],
                  let expires = object["expires"] as? String,
                  expires.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
            else { return nil }
            for list in ["ios", "android", "web"] where object[list] != nil && !(object[list] is [String]) { return nil }
            if let server = object["server"], CFGetTypeID(server as CFTypeRef) != CFBooleanGetTypeID() { return nil }
            self.v = v.intValue
            self.id = id
            self.customer = customer
            self.modules = modules
            self.ios = object["ios"] as? [String] ?? []
            self.expires = expires
        }
    }
}
```

A non-integer `v` such as `1.5` must fail: add `guard v.doubleValue == Double(v.intValue)` to the `Payload` init if the conformance cases ever include one; today none do.

- [ ] **Step 4: Write `ios/Sources/PdfiumKit/License/PdfLicense.swift`**

```swift
import Foundation
import os

/// Set at release by scripts/set-release-date.sh. The private half of the public key is
/// held outside this repository.
enum LicenseBuild {
    static let releaseDate = "2026-09-15"
    static let publicKey = "REPLACED_IN_TASK_12"
    static let revoked: Set<String> = []
}

/// The SDK's license. Without a key covering a feature, the feature still works and
/// its output carries a watermark.
public enum PdfLicense {
    private static let lock = NSLock()
    private static var context = LicenseContext(publicKey: LicenseBuild.publicKey, revoked: LicenseBuild.revoked,
                                                releaseDate: LicenseBuild.releaseDate,
                                                appIdentifier: Bundle.main.bundleIdentifier)
    private static var key: String?
    private static var current: PdfLicenseStatus = .trial(reason: .noKey, message: "no license key set")
    private static var warned = false
    private static let log = Logger(subsystem: "com.pdfiumkit", category: "license")

    /// Sets the license key. Call before opening documents. Never throws: a bad key
    /// leaves the SDK in trial mode, and ``status`` says why.
    public static func setKey(_ key: String) {
        lock.lock(); defer { lock.unlock() }
        self.key = key
        current = LicenseKey.evaluate(key, context: context)
    }

    public static var status: PdfLicenseStatus {
        lock.lock(); defer { lock.unlock() }
        return current
    }

    /// Logs once per process, the first time anything is watermarked.
    static func noteWatermark(_ detail: String) {
        lock.lock()
        let first = !warned
        warned = true
        lock.unlock()
        if first { log.warning("PdfiumKit: output is watermarked — \(detail, privacy: .public)") }
    }

    /// Test hook. Internal, so only `@testable` code reaches it.
    @discardableResult
    static func configureForTesting(publicKey: String? = nil, revoked: Set<String>? = nil,
                                    releaseDate: String? = nil, appIdentifier: String? = nil,
                                    key: String?? = .none) -> PdfLicenseStatus {
        lock.lock(); defer { lock.unlock() }
        if let publicKey { context.publicKey = publicKey }
        if let revoked { context.revoked = revoked }
        if let releaseDate { context.releaseDate = releaseDate }
        if let appIdentifier { context.appIdentifier = appIdentifier }
        if case .some(let value) = key { self.key = value }
        current = LicenseKey.evaluate(self.key, context: context)
        return current
    }
}
```

`Logger` needs iOS 14; the package floor is iOS 15.

- [ ] **Step 5: Run the license tests**

Run: `xcodebuild test -scheme PdfiumKit-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PdfiumKitTests/LicenseTests 2>&1 | grep -E "error:|Executed|failed" | head`
Expected: `Executed 1 test, with 0 failures`.

- [ ] **Step 6: Run the iOS gate**

Run: `./scripts/test-ios.sh 2>&1 | grep -E "Executed|error:|cross-check|TEST FAILED" | tail -12`
Expected: all suites pass as before (the key changes nothing yet), pdfsig cross-check passes.

- [ ] **Step 7: Commit**

```bash
git add ios/Sources/PdfiumKit/License ios/Tests
git commit -m "iOS: license keys, verified offline"
```

---

### Task 7: iOS watermark, marking and gates

**Files:**
- Create: `ios/Sources/PdfiumKit/License/Watermark.swift`
- Modify: `ios/Sources/PdfiumKit/PdfDocument.swift` (mark at init, `use`), `ios/Sources/PdfiumKit/Save.swift` (extract `serialise`), `ios/Sources/PdfiumKit/Render.swift` (overlay), `ios/Sources/PdfiumKit/Sign/Sign.swift` (stamp before signing), `ios/Sources/PdfiumKit/Redact/Redact.swift`, `ios/Sources/PdfiumKit/PdfAnnotation.swift:248,273,298,316`, `ios/Sources/PdfiumKit/PdfFormField.swift:184,206,225,236`, `ios/Sources/PdfiumKit/PdfPage.swift:60`, `scripts/test-ios.sh`
- Test: `ios/Tests/PdfiumKitTests/LicenseTests.swift`

**Interfaces:**
- Consumes: `PdfLicense.status`, `PdfLicense.noteWatermark`, `PdfLicense.configureForTesting` (Task 6).
- Produces:
  - `enum Watermark { static func draw(on bitmap: FPDF_BITMAP, width: Int32, height: Int32); static func stamp(_ data: Data) throws -> Data }`
  - `extension PdfDocument { static func serialise(_ handle: FPDF_DOCUMENT, flags: FPDF_DWORD) throws -> Data }`
  - actor-isolated `PdfDocument.use(_ module: PdfLicenseModule)`, `PdfDocument.needsWatermark: Bool` (internal)

- [ ] **Step 1: Write the failing behaviour tests**

Append to `LicenseTests`:
```swift
    private let mark = "PdfiumKit trial"

    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    private func use(_ key: String?) throws {
        PdfLicense.configureForTesting(key: .some(key))
    }

    private func keyWith(_ modules: [String]) throws -> String {
        let url = Repo.root.appendingPathComponent("conformance/license/partial-keys.json")
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String])
        return try XCTUnwrap(keys[modules.joined(separator: ",")], "missing key for \(modules)")
    }

    private func texts(_ data: Data) async throws -> [String] {
        let document = try await PdfDocument(data: data)
        var result: [String] = []
        for index in 0..<(await document.pageCount) {
            result.append(try await document.page(index).text.string())
        }
        return result
    }

    private func greyPixels(_ image: UIImage) -> Int {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return 0 }
        var count = 0
        for i in stride(from: 0, to: cg.width * cg.height * 4, by: 4) {
            let (b, g, r) = (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
            if r < 250, r > 150, abs(r - g) < 8, abs(g - b) < 8 { count += 1 }
        }
        return count
    }

    func testTrialRenderIsWatermarked() async throws {
        let licensed = try await PdfDocument(data: try read("hello_world.pdf")).page(0).render(width: 400)
        try use(nil)
        let trial = try await PdfDocument(data: try read("hello_world.pdf")).page(0).render(width: 400)
        XCTAssertGreaterThan(greyPixels(trial), greyPixels(licensed) + 500)
    }

    func testTrialSaveIsWatermarkedOnEveryPage() async throws {
        try use(nil)
        let trial = try await PdfDocument(data: try read("rectangles_multi_pages.pdf")).data()
        for text in try await texts(trial) { XCTAssertTrue(text.contains(mark)) }
        LicensedTestCase.installFullTestLicense()
        let licensed = try await PdfDocument(data: try read("rectangles_multi_pages.pdf")).data()
        for text in try await texts(licensed) { XCTAssertFalse(text.contains(mark)) }
    }

    func testSavingTwiceStampsOnce() async throws {
        try use(nil)
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        _ = try await document.data()
        let text = try await texts(try await document.data())[0]
        XCTAssertEqual(text.components(separatedBy: mark).count - 1, 1)
    }

    func testIncrementalSaveOfMarkedDocumentIsFullAndWatermarked() async throws {
        try use(nil)
        let original = try read("hello_world.pdf")
        let saved = try await PdfDocument(data: original).data(mode: .incremental)
        XCTAssertNotEqual(saved.prefix(original.count), original)
        XCTAssertTrue(try await texts(saved)[0].contains(mark))
    }

    func testUnlicensedModuleMarksTheDocument() async throws {
        try use(try keyWith(["forms"]))
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let before = await document.needsWatermark
        XCTAssertFalse(before)
        try await document.page(0).addNote(rect: PdfRect(left: 10, bottom: 10, right: 30, top: 30), contents: "x")
        let after = await document.needsWatermark
        XCTAssertTrue(after)
    }

    func testUnlicensedRedactionStillRemovesText() async throws {
        try use(try keyWith([]))
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        _ = try await document.redact([.textMatches(query: "Hello")])
        let text = try await texts(try await document.data())[0]
        XCTAssertFalse(text.contains("Hello"))
        XCTAssertTrue(text.contains(mark))
    }

    /// pdfsig runs on the host over this file; see scripts/test-ios.sh.
    func testWritesAnUnlicensedSignedDocumentForTheHost() async throws {
        try use(try keyWith([]))
        let p12 = try Data(contentsOf: Repo.root.appendingPathComponent("conformance/fixtures/test-signer.p12"))
        let signed = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try Pkcs12Signer(pkcs12: p12, password: "pdfiumkit")))
        XCTAssertTrue(try await texts(signed)[0].contains(mark))
        try signed.write(to: URL(fileURLWithPath: "/tmp/pdfiumkit-ios-trial-signed.pdf"))
    }
```

Check the real redaction target case name: `grep -n "case " ios/Sources/PdfiumKit/Redact/*.swift | grep -i "textMatch\|search"`, and the `PdfRect` initialiser labels in `Geometry.swift`; adjust the two calls to match.

- [ ] **Step 2: Run to verify they fail**

Run: `xcodebuild test -scheme PdfiumKit-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PdfiumKitTests/LicenseTests 2>&1 | grep -E "error:|Executed" | head`
Expected: build error, `value of type 'PdfDocument' has no member 'needsWatermark'`.

- [ ] **Step 3: Extract `serialise` in `Save.swift`**

Replace the body of `data(mode:)` with a call to a new static function holding the existing logic:
```swift
extension PdfDocument {
    /// Serialises the document, including any edits made through this SDK. A document
    /// that needs the watermark is always saved in full.
    public func data(mode: PdfSaveMode = .full) throws -> Data {
        let handle = try requireHandle()

        // Commit any in-progress form edit before serialising, or the last field typed
        // into is silently omitted.
        if let form { FORM_ForceToKillFocus(form) }

        guard needsWatermark else {
            return try Self.serialise(handle, flags: FPDF_DWORD(mode == .incremental ? FPDF_INCREMENTAL : FPDF_NO_INCREMENTAL))
        }
        noteWatermarked()
        return try Watermark.stamp(try Self.serialise(handle, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL)))
    }

    static func serialise(_ handle: FPDF_DOCUMENT, flags: FPDF_DWORD) throws -> Data {
        let buffer = SaveBuffer()
        var context = SaveContext(
            base: FPDF_FILEWRITE(version: 1, WriteBlock: writeBlock),
            buffer: Unmanaged.passUnretained(buffer).toOpaque()
        )
        let ok = withUnsafeMutablePointer(to: &context) {
            $0.withMemoryRebound(to: FPDF_FILEWRITE.self, capacity: 1) {
                FPDF_SaveAsCopy(handle, $0, flags)
            }
        }
        guard ok != 0 else { throw PdfError.saveFailed(reason: "PDFium refused to serialise the document") }
        guard !buffer.data.isEmpty else { throw PdfError.saveFailed(reason: "no bytes were produced") }
        return buffer.data
    }
```
Keep `write(to:mode:)` unchanged.

- [ ] **Step 4: Write `Watermark.swift`**

```swift
import Foundation
@_implementationOnly import CPdfium

/// The trial watermark, drawn with PDFium so it looks the same on every platform.
enum Watermark {
    private static let text = "PdfiumKit trial"

    /// Adds the watermark to `page`, centred on the box and running along its diagonal.
    private static func place(in document: FPDF_DOCUMENT, page: FPDF_PAGE,
                              left: Float, bottom: Float, width: Float, height: Float) {
        guard let object = FPDFPageObj_NewTextObj(document, "Helvetica-Bold", 100) else { return }
        var units = Array(text.utf16) + [0]
        units.withUnsafeMutableBufferPointer { _ = FPDFText_SetText(object, $0.baseAddress) }
        FPDFPageObj_SetFillColor(object, 128, 128, 128, 64)

        var l: Float = 0, b: Float = 0, r: Float = 0, t: Float = 0
        FPDFPageObj_GetBounds(object, &l, &b, &r, &t)
        let angle = atan2(Double(height), Double(width))
        let scale = hypot(Double(width), Double(height)) * 0.6 / max(1, Double(r - l))
        let c = cos(angle) * scale
        let s = sin(angle) * scale
        FPDFPageObj_Transform(object, 1, 0, 0, 1, -Double(l + r) / 2, -Double(b + t) / 2)
        FPDFPageObj_Transform(object, c, s, -s, c,
                              Double(left) + Double(width) / 2, Double(bottom) + Double(height) / 2)
        FPDFPage_InsertObject(page, object)
        FPDFPage_GenerateContent(page)
    }

    /// Draws over an already rendered bitmap; the document is not touched.
    static func draw(on bitmap: FPDF_BITMAP, width: Int32, height: Int32) {
        guard let scratch = FPDF_CreateNewDocument() else { return }
        defer { FPDF_CloseDocument(scratch) }
        guard let page = FPDFPage_New(scratch, 0, Double(width), Double(height)) else { return }
        place(in: scratch, page: page, left: 0, bottom: 0, width: Float(width), height: Float(height))
        FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
        FPDF_ClosePage(page)
    }

    /// A full save of `data` with the watermark in every page's content.
    static func stamp(_ data: Data) throws -> Data {
        try data.withUnsafeBytes { raw in
            guard let document = FPDF_LoadMemDocument(raw.baseAddress, Int32(data.count), nil) else {
                throw PdfError.saveFailed(reason: "the saved document could not be reopened to watermark it")
            }
            defer { FPDF_CloseDocument(document) }
            for index in 0..<FPDF_GetPageCount(document) {
                guard let page = FPDF_LoadPage(document, index) else { continue }
                var l: Float = 0, b: Float = 0, r: Float = 0, t: Float = 0
                let hasBox = FPDFPage_GetMediaBox(page, &l, &b, &r, &t) != 0
                place(in: document, page: page, left: hasBox ? l : 0, bottom: hasBox ? b : 0,
                      width: FPDF_GetPageWidthF(page), height: FPDF_GetPageHeightF(page))
                FPDF_ClosePage(page)
            }
            return try PdfDocument.serialise(document, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL))
        }
    }
}
```

The `data.withUnsafeBytes` buffer stays valid for the whole closure, which covers the save; PDFium reads lazily from it.

- [ ] **Step 5: Mark and gate in `PdfDocument.swift` and the entry points**

In `PdfDocument.swift`:
- Add a stored property after `private var cachedFingerprint: String?`:
```swift
    /// Set at open in trial mode, or by ``use(_:)`` when a feature is not licensed.
    private(set) var needsWatermark = PdfLicense.status.isTrial
```
- Add to the actor body, after `public var isClosed: Bool { handle == nil }`:
```swift
    /// Every paid entry point calls this first. The operation runs either way.
    func use(_ module: PdfLicenseModule) {
        if !PdfLicense.status.covers(module) { needsWatermark = true }
    }

    func noteWatermarked() {
        switch PdfLicense.status {
        case .trial(_, let message): PdfLicense.noteWatermark(message)
        case .licensed: PdfLicense.noteWatermark("the license key does not cover every module used")
        }
    }
```

Add `use(.editing)` as the first statement of: `addMarkup` (`PdfAnnotation.swift:248`), `addInk` (`:273`), `addNote` (`:298`), `removeAnnotation` (`:316`), `setPageRotation` (`PdfPage.swift:60`).

Add `use(.forms)` as the first statement of: `setFormText` (`PdfFormField.swift:184`), `setFormChecked` (`:206`), `toggleFormField` (`:225`), `setFormOption` (`:236`).

Add `use(.redaction)` as the first statement of `redact(_:)` in `Redact.swift:61`.

In `Render.swift`, in `render(pageIndex:pixelSize:options:background:)`, directly before `return try image(from: bitmap, …)`:
```swift
        if needsWatermark {
            noteWatermarked()
            Watermark.draw(on: bitmap, width: w, height: h)
        }
```

In `Sign.swift`, replace `sign(_:)` on `PdfDocument`:
```swift
    /// Signs the document, returning the signed bytes.
    ///
    /// The original bytes are never modified: the signature is appended as an incremental
    /// update, so any signature already present keeps verifying. Without a signing
    /// license the bytes are first watermarked, which is a full rewrite, so earlier
    /// signatures in the result no longer verify.
    public func sign(_ options: PdfSignOptions) async throws -> Data {
        use(.signing)
        guard needsWatermark else { return try await Signer.sign(backing, options: options) }
        noteWatermarked()
        _ = try requireHandle()
        return try await Signer.sign(try Watermark.stamp(backing), options: options)
    }
```

- [ ] **Step 6: Cross-check the unlicensed signature on the host**

In `scripts/test-ios.sh`, after the existing pdfsig block for `$SIGNED`, add the same checks for `/tmp/pdfiumkit-ios-trial-signed.pdf`, printing `cross-check:   pdfsig accepts the iOS trial-signed document`. Extract the two `case` checks into a shell function `check_pdfsig <file> <label>` and call it for both files, so the logic exists once.

- [ ] **Step 7: Run the license tests, then the gate**

Run: `xcodebuild test -scheme PdfiumKit-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PdfiumKitTests/LicenseTests 2>&1 | grep -E "error:|Executed|failed" | head`
Expected: `Executed 8 tests, with 0 failures`.

Run: `./scripts/test-ios.sh 2>&1 | grep -E "Executed|error:|cross-check|TEST FAILED" | tail -14`
Expected: every suite passes; both pdfsig cross-checks pass.

- [ ] **Step 8: Commit**

```bash
git add ios scripts/test-ios.sh
git commit -m "iOS: watermark rendering, saving and signing without a covering license"
```

---

### Task 8: iOS AI trial prefix

**Files:**
- Modify: `ios/Sources/PdfiumKitAI/PdfiumAI.swift` (`ask`, `summarize`), create `ios/Sources/PdfiumKitAI/Trial.swift`
- Test: `ios/Tests/PdfiumKitAITests/TrialTests.swift`

**Interfaces:**
- Consumes: `PdfLicense.status.covers(.ai)`.
- Produces: `enum Trial { static let prefix: String; static func mark(_ outcome: PdfAiOutcome<PdfAnswer>, licensed: Bool) -> PdfAiOutcome<PdfAnswer>; static func mark(_ outcome: PdfAiOutcome<PdfSummary>, licensed: Bool) -> PdfAiOutcome<PdfSummary> }`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import PdfiumKitAI

final class TrialTests: LicensedTestCase {
    func testAnswersAndSummariesArePrefixedWithoutAnAiLicense() {
        let answer = PdfAiOutcome<PdfAnswer>.answered(PdfAiResult(
            value: .answered(text: "Yes.", citations: [], grounded: true, pagesWithoutText: []), source: .rules))
        guard case .answered(let marked) = Trial.mark(answer, licensed: false),
              case .answered(let text, _, _, _) = marked.value else { return XCTFail() }
        XCTAssertEqual(text, "PdfiumKit trial — Yes.")

        let summary = PdfAiOutcome<PdfSummary>.answered(PdfAiResult(
            value: PdfSummary(text: "Short.", pagesWithoutText: []), source: .rules))
        guard case .answered(let kept) = Trial.mark(summary, licensed: true) else { return XCTFail() }
        XCTAssertEqual(kept.value.text, "Short.")
    }
}
```

If `PdfAiResult` or `PdfSummary` have no accessible memberwise initialisers from tests, `@testable` makes the internal ones visible; otherwise add `init`s marked internal.

- [ ] **Step 2: Run to verify it fails**

Run: `xcodebuild test -scheme PdfiumKit-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PdfiumKitAITests/TrialTests 2>&1 | grep -E "error:|Executed" | head -3`
Expected: `cannot find 'Trial' in scope`.

- [ ] **Step 3: Implement `Trial.swift`**

```swift
import Foundation
import os
import PdfiumKit

/// Marks model output produced without an `ai` license. Quotes are never touched, so
/// grounding still verifies.
enum Trial {
    static let prefix = "PdfiumKit trial — "
    private static let warned = OSAllocatedUnfairLock(initialState: false)

    static func mark(_ outcome: PdfAiOutcome<PdfAnswer>,
                     licensed: Bool = PdfLicense.status.covers(.ai)) -> PdfAiOutcome<PdfAnswer> {
        guard !licensed, case .answered(let result) = outcome,
              case .answered(let text, let citations, let grounded, let pages) = result.value else { return outcome }
        warn()
        return .answered(PdfAiResult(value: .answered(text: prefix + text, citations: citations,
                                                      grounded: grounded, pagesWithoutText: pages),
                                     source: result.source))
    }

    static func mark(_ outcome: PdfAiOutcome<PdfSummary>,
                     licensed: Bool = PdfLicense.status.covers(.ai)) -> PdfAiOutcome<PdfSummary> {
        guard !licensed, case .answered(let result) = outcome else { return outcome }
        warn()
        return .answered(PdfAiResult(value: PdfSummary(text: prefix + result.value.text,
                                                       pagesWithoutText: result.value.pagesWithoutText),
                                     source: result.source))
    }

    private static func warn() {
        let first = warned.withLock { value -> Bool in defer { value = true }; return !value }
        if first {
            Logger(subsystem: "com.pdfiumkit", category: "license")
                .warning("PdfiumKit: AI output is marked as trial — the license key does not include the ai module")
        }
    }
}
```

`OSAllocatedUnfairLock` needs iOS 16; the floor is 15. Use an `NSLock` and a `static var` instead if the build reports availability errors.

In `PdfiumAI.swift`:
- `ask`: wrap the early rules return and the final return. Change `return .answered(PdfAiResult(value: .notFound(…), source: .rules))` — leave it (not-found carries no text). Change `return await resolveRoutes(` to `return Trial.mark(await resolveRoutes(` and close the extra parenthesis after the `resolveRoutes` call's closing `)`.
- `summarize`: same change on its `return await resolveRoutes(`.

- [ ] **Step 4: Run AI tests**

Run: `xcodebuild test -scheme PdfiumKit-Package -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PdfiumKitAITests 2>&1 | grep -E "error:|Executed" | tail -3`
Expected: 42 existing + 1 pass.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/PdfiumKitAI ios/Tests/PdfiumKitAITests
git commit -m "iOS AI: mark answers and summaries without an ai license"
```

---

### Task 9: Android license state and conformance

**Files:**
- Create: `android/pdfiumkit/src/main/java/com/pdfiumkit/license/LicenseKey.kt`, `android/pdfiumkit/src/main/java/com/pdfiumkit/license/PdfLicense.kt`, `android/pdfiumkit/src/androidTest/java/com/pdfiumkit/LicensedTestRunner.kt`, `android/pdfiumkit/src/androidTest/java/com/pdfiumkit/LicenseTest.kt`
- Modify: `android/pdfiumkit/build.gradle.kts:21` (runner)

**Interfaces:**
- Consumes: `cases.json` as the asset `license/cases.json` (the androidTest assets root is `conformance/`; confirm with `sed -n 55,62p android/pdfiumkit/build.gradle.kts`).
- Produces:
  - `enum class PdfLicenseModule(val id: String) { EDITING("editing"), FORMS("forms"), SIGNING("signing"), REDACTION("redaction"), AI("ai") }`
  - `enum class PdfLicenseReason(val id: String) { NO_KEY("noKey"), MALFORMED("malformed"), BAD_SIGNATURE("badSignature"), UNSUPPORTED_VERSION("unsupportedVersion"), REVOKED("revoked"), EXPIRED("expired"), WRONG_APP("wrongApp") }`
  - `sealed interface PdfLicenseStatus { data class Licensed(val customer: String, val modules: Set<PdfLicenseModule>); data class Trial(val reason: PdfLicenseReason, val message: String); fun covers(module: PdfLicenseModule): Boolean; val isTrial: Boolean }`
  - `object PdfLicense { fun setKey(context: Context, key: String); val status: PdfLicenseStatus }`
  - internal: `PdfLicense.configureForTesting(publicKey: String? = null, revoked: Set<String>? = null, releaseDate: String? = null, appIdentifier: String? = null, key: String? = null, setKey: Boolean = false): PdfLicenseStatus`, `PdfLicense.noteWatermark(detail: String)`

- [ ] **Step 1: Write the failing test and the runner**

`LicenseTest.kt`:
```kotlin
package com.pdfiumkit

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfiumkit.license.PdfLicense
import com.pdfiumkit.license.PdfLicenseStatus
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

internal object LicenseFixture {
    val json: JSONObject by lazy {
        JSONObject(InstrumentationRegistry.getInstrumentation().context.assets
            .open("license/cases.json").use { it.readBytes().decodeToString() })
    }

    fun installFullKey() {
        PdfLicense.configureForTesting(
            publicKey = json.getString("publicKey"),
            revoked = (0 until json.getJSONArray("revoked").length()).map { json.getJSONArray("revoked").getString(it) }.toSet(),
            releaseDate = json.getString("releaseDate"),
            appIdentifier = json.getString("app"),
            key = json.getString("fullKey"), setKey = true,
        )
    }
}

@RunWith(AndroidJUnit4::class)
class LicenseTest {
    @After fun restore() = LicenseFixture.installFullKey()

    @Test fun sharedCases() {
        val fixture = LicenseFixture.json
        val cases = fixture.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            val status = PdfLicense.configureForTesting(
                publicKey = fixture.getString("publicKey"),
                revoked = setOf("lic_revoked"),
                releaseDate = fixture.getString("releaseDate"),
                appIdentifier = fixture.getString("app"),
                key = if (c.isNull("key")) null else c.getString("key"), setKey = true,
            )
            val expected = c.getJSONObject("expected").getJSONObject("android")
            when (status) {
                is PdfLicenseStatus.Licensed -> {
                    assertEquals("$name: $status", "licensed", expected.getString("kind"))
                    val modules = expected.getJSONArray("modules")
                    assertEquals(name, (0 until modules.length()).map { modules.getString(it) },
                                 status.modules.map { it.id }.sorted())
                }
                is PdfLicenseStatus.Trial -> {
                    assertEquals("$name: ${status.message}", "trial", expected.getString("kind"))
                    assertEquals("$name: ${status.message}", expected.getString("reason"), status.reason.id)
                }
            }
        }
    }
}
```

`LicensedTestRunner.kt`:
```kotlin
package com.pdfiumkit

import android.os.Bundle
import androidx.test.runner.AndroidJUnitRunner

/** Every instrumented test runs licensed for every module; license tests change it locally. */
class LicensedTestRunner : AndroidJUnitRunner() {
    override fun onStart() {
        LicenseFixture.installFullKey()
        super.onStart()
    }
}
```

In `android/pdfiumkit/build.gradle.kts` change line 21 to:
```kotlin
        testInstrumentationRunner = "com.pdfiumkit.LicensedTestRunner"
```
`scripts/sweep-android.sh` names the runner; change `$PACKAGE/androidx.test.runner.AndroidJUnitRunner` there to `$PACKAGE/com.pdfiumkit.LicensedTestRunner`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && gradle :pdfiumkit:compileDebugAndroidTestKotlin --console=plain -q 2>&1 | grep "^e:" | head -3`
Expected: `e: … Unresolved reference: license`.

- [ ] **Step 3: Write `LicenseKey.kt`**

```kotlin
package com.pdfiumkit.license

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

enum class PdfLicenseModule(val id: String) {
    EDITING("editing"), FORMS("forms"), SIGNING("signing"), REDACTION("redaction"), AI("ai")
}

enum class PdfLicenseReason(val id: String) {
    NO_KEY("noKey"), MALFORMED("malformed"), BAD_SIGNATURE("badSignature"),
    UNSUPPORTED_VERSION("unsupportedVersion"), REVOKED("revoked"), EXPIRED("expired"), WRONG_APP("wrongApp")
}

sealed interface PdfLicenseStatus {
    data class Licensed(val customer: String, val modules: Set<PdfLicenseModule>) : PdfLicenseStatus
    data class Trial(val reason: PdfLicenseReason, val message: String) : PdfLicenseStatus

    fun covers(module: PdfLicenseModule): Boolean = this is Licensed && module in modules
    val isTrial: Boolean get() = this is Trial
}

internal data class LicenseContext(
    val publicKey: String,
    val revoked: Set<String>,
    val releaseDate: String,
    val appIdentifier: String?,
)

/** `pk1.<payload>.<signature>`, verified offline. See the licensing spec. */
internal object LicenseKey {
    /** The DER header of a P-256 SubjectPublicKeyInfo, before the 65-byte point. */
    private val SPKI_PREFIX = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
    private val DATE = Regex("""^\d{4}-\d{2}-\d{2}$""")

    fun evaluate(key: String?, context: LicenseContext): PdfLicenseStatus {
        val trimmed = key?.trim()
        if (trimmed.isNullOrEmpty()) return PdfLicenseStatus.Trial(PdfLicenseReason.NO_KEY, "no license key set")
        val malformed = PdfLicenseStatus.Trial(PdfLicenseReason.MALFORMED, "license key is malformed")

        val parts = trimmed.split(".")
        if (parts.size != 3 || parts[0] != "pk1") return malformed
        val payloadBytes = base64url(parts[1]) ?: return malformed
        val signatureBytes = base64url(parts[2]) ?: return malformed
        val payload = Payload.parse(payloadBytes) ?: return malformed

        if (!verify(context.publicKey, payloadBytes, signatureBytes)) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.BAD_SIGNATURE, "license key signature is invalid")
        }
        if (payload.v != 1) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.UNSUPPORTED_VERSION,
                "license key version ${payload.v} is not supported by this SDK")
        }
        if (payload.id in context.revoked) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.REVOKED, "license key ${payload.id} has been revoked")
        }
        if (context.releaseDate > payload.expires) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.EXPIRED,
                "license key expired on ${payload.expires}, before this SDK was released on ${context.releaseDate}")
        }
        val app = context.appIdentifier
        if (app == null || app !in payload.android) {
            val listed = payload.android.joinToString(", ").ifEmpty { "no Android apps" }
            return PdfLicenseStatus.Trial(PdfLicenseReason.WRONG_APP, "key is for $listed, this app is ${app ?: "unknown"}")
        }
        val modules = PdfLicenseModule.values().filter { it.id in payload.modules }.toSet()
        return PdfLicenseStatus.Licensed(payload.customer, modules)
    }

    private fun verify(publicKey: String, payload: ByteArray, signature: ByteArray): Boolean = try {
        val point = base64url(publicKey) ?: return false
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + point))
        signature.size == 64 && Signature.getInstance("SHA256withECDSA").run {
            initVerify(key)
            update(payload)
            verify(rawToDer(signature))
        }
    } catch (e: Exception) {
        false
    }

    /** WebCrypto and CryptoKit use raw r‖s; java.security wants a DER SEQUENCE of two INTEGERs. */
    private fun rawToDer(raw: ByteArray): ByteArray {
        fun integer(bytes: ByteArray): ByteArray {
            var value = bytes.dropWhile { it == 0.toByte() }.toByteArray()
            if (value.isEmpty()) value = byteArrayOf(0)
            if (value[0] < 0) value = byteArrayOf(0) + value
            return byteArrayOf(0x02, value.size.toByte()) + value
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun base64url(text: String): ByteArray? {
        if (!text.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) return null
        if (text.length % 4 == 1) return null
        return try {
            Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private class Payload(
        val v: Int, val id: String, val customer: String,
        val modules: List<String>, val android: List<String>, val expires: String,
    ) {
        companion object {
            fun parse(bytes: ByteArray): Payload? = try {
                val json = JSONObject(bytes.decodeToString(throwOnInvalidSequence = true))
                val v = json.get("v")
                val listsValid = listOf("ios", "android", "web").all { !json.has(it) || strings(json.get(it)) != null }
                val serverValid = !json.has("server") || json.get("server") is Boolean
                val expires = json.get("expires")
                if (v !is Int || json.get("id") !is String || json.get("customer") !is String ||
                    strings(json.get("modules")) == null || expires !is String || !DATE.matches(expires) ||
                    !listsValid || !serverValid) null
                else Payload(v, json.getString("id"), json.getString("customer"),
                             strings(json.get("modules"))!!,
                             if (json.has("android")) strings(json.get("android"))!! else emptyList(),
                             expires)
            } catch (e: Exception) {
                null
            }

            private fun strings(value: Any?): List<String>? =
                (value as? JSONArray)?.let { array ->
                    (0 until array.length()).map { array.get(it) as? String ?: return null }
                }
        }
    }
}
```

`org.json` parses `1` as `Integer` and `1.5` as `Double`, so `v !is Int` rejects non-integers.

- [ ] **Step 4: Write `PdfLicense.kt`**

```kotlin
package com.pdfiumkit.license

import android.content.Context
import android.util.Log

/** Set at release by scripts/set-release-date.sh. The private key is held outside this repository. */
internal object LicenseBuild {
    const val RELEASE_DATE = "2026-09-15"
    const val PUBLIC_KEY = "REPLACED_IN_TASK_12"
    val REVOKED: Set<String> = emptySet()
}

/** The SDK's license. Without a key covering a feature, the feature still works and its output carries a watermark. */
object PdfLicense {
    private var context = LicenseContext(LicenseBuild.PUBLIC_KEY, LicenseBuild.REVOKED, LicenseBuild.RELEASE_DATE, null)
    private var key: String? = null
    @Volatile private var current: PdfLicenseStatus =
        PdfLicenseStatus.Trial(PdfLicenseReason.NO_KEY, "no license key set")
    @Volatile private var warned = false

    /** Sets the license key. Call before opening documents. Never throws. */
    @Synchronized
    fun setKey(context: Context, key: String) {
        this.context = this.context.copy(appIdentifier = context.packageName)
        this.key = key
        current = LicenseKey.evaluate(key, this.context)
    }

    val status: PdfLicenseStatus get() = current

    /** Logs once per process, the first time anything is watermarked. */
    internal fun noteWatermark(detail: String) {
        if (warned) return
        warned = true
        Log.w("PdfiumKit", "output is watermarked — $detail")
    }

    /** Test hook; internal to this module. */
    @Synchronized
    internal fun configureForTesting(
        publicKey: String? = null, revoked: Set<String>? = null, releaseDate: String? = null,
        appIdentifier: String? = null, key: String? = null, setKey: Boolean = false,
    ): PdfLicenseStatus {
        context = context.copy(
            publicKey = publicKey ?: context.publicKey,
            revoked = revoked ?: context.revoked,
            releaseDate = releaseDate ?: context.releaseDate,
            appIdentifier = appIdentifier ?: context.appIdentifier,
        )
        if (setKey) this.key = key
        current = LicenseKey.evaluate(this.key, context)
        return current
    }
}
```

- [ ] **Step 5: Run the license test**

Run: `cd android && ANDROID_SERIAL=emulator-5554 gradle :pdfiumkit:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.pdfiumkit.LicenseTest --console=plain -q 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL, 1 test passed.

- [ ] **Step 6: Run the Android gate**

Run: `ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh 2>&1 | grep -E "tests completed|FAILED|BUILD|cross-check" | tail -10`
Expected: every suite passes; pdfsig cross-check passes. If `scripts/test-android.sh` passes its own `-e class` runs with a runner name, update it the same way as the sweep script.

- [ ] **Step 7: Commit**

```bash
git add android scripts/sweep-android.sh scripts/test-android.sh
git commit -m "Android: license keys, verified offline"
```

---

### Task 10: Android watermark, marking and gates

**Files:**
- Create: `android/pdfiumkit/src/main/cpp/watermark.cpp`, `android/pdfiumkit/src/main/cpp/watermark.h`
- Modify: `android/pdfiumkit/src/main/cpp/CMakeLists.txt` (add source), `android/pdfiumkit/src/main/cpp/pdfiumkit_jni.cpp` (`renderPage` gains `watermark`, new `stampWatermark`), `Native.kt`, `PdfDocument.kt` (mark, `use`, render, `toByteArray`, `setRotation`), `PageContent.kt` (gates), `Redact.kt:87`, `sign/Sign.kt:53`, `LicenseTest.kt`, `scripts/test-android.sh`

**Interfaces:**
- Consumes: `PdfLicense.status`, `PdfLicense.noteWatermark` (Task 9).
- Produces:
  - C++: `void pdfiumkit_draw_watermark(FPDF_BITMAP bitmap, int width, int height);` and `std::vector<uint8_t> pdfiumkit_stamp_watermark(const uint8_t* data, size_t size);`
  - `Native.renderPage(handle, index, bitmap, flags, background, drawForms, watermark: Boolean): Boolean`, `Native.stampWatermark(bytes: ByteArray): ByteArray`
  - `PdfDocument.needsWatermark: Boolean` (internal), `PdfDocument.use(module: PdfLicenseModule)` (internal)

- [ ] **Step 1: Write the failing behaviour tests**

Append to `LicenseTest`:
```kotlin
    private val mark = "PdfiumKit trial"
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private fun corpus(name: String) = assets.open("corpus/$name").use { it.readBytes() }
    private fun use(key: String?) { PdfLicense.configureForTesting(key = key, setKey = true) }
    private fun keyWith(modules: String): String =
        JSONObject(assets.open("license/partial-keys.json").use { it.readBytes().decodeToString() }).getString(modules)

    private suspend fun texts(bytes: ByteArray): List<String> = PdfDocument.open(bytes).use { d ->
        (0 until d.pageCount()).map { d.page(it).text.string() }
    }

    private fun greyPixels(bitmap: android.graphics.Bitmap): Int {
        var count = 0
        for (y in 0 until bitmap.height) for (x in 0 until bitmap.width) {
            val p = bitmap.getPixel(x, y)
            val (r, g, b) = Triple(p shr 16 and 0xff, p shr 8 and 0xff, p and 0xff)
            if (r in 151..249 && kotlin.math.abs(r - g) < 8 && kotlin.math.abs(g - b) < 8) count++
        }
        return count
    }

    @Test fun trialRenderIsWatermarked() = kotlinx.coroutines.runBlocking {
        val licensed = PdfDocument.open(corpus("hello_world.pdf")).use { it.page(0).render(400) }
        use(null)
        val trial = PdfDocument.open(corpus("hello_world.pdf")).use { it.page(0).render(400) }
        org.junit.Assert.assertTrue(greyPixels(trial) > greyPixels(licensed) + 500)
    }

    @Test fun trialSaveIsWatermarkedOnEveryPage() = kotlinx.coroutines.runBlocking {
        use(null)
        val trial = PdfDocument.open(corpus("rectangles_multi_pages.pdf")).use { it.toByteArray() }
        texts(trial).forEach { org.junit.Assert.assertTrue(it.contains(mark)) }
        LicenseFixture.installFullKey()
        val licensed = PdfDocument.open(corpus("rectangles_multi_pages.pdf")).use { it.toByteArray() }
        texts(licensed).forEach { org.junit.Assert.assertFalse(it.contains(mark)) }
    }

    @Test fun savingTwiceStampsOnce() = kotlinx.coroutines.runBlocking {
        use(null)
        PdfDocument.open(corpus("hello_world.pdf")).use { d ->
            d.toByteArray()
            assertEquals(1, texts(d.toByteArray())[0].split(mark).size - 1)
        }
    }

    @Test fun incrementalSaveOfMarkedDocumentIsFullAndWatermarked() = kotlinx.coroutines.runBlocking {
        use(null)
        val original = corpus("hello_world.pdf")
        val saved = PdfDocument.open(original).use { it.toByteArray(PdfSaveMode.INCREMENTAL) }
        org.junit.Assert.assertFalse(saved.copyOfRange(0, original.size).contentEquals(original))
        org.junit.Assert.assertTrue(texts(saved)[0].contains(mark))
    }

    @Test fun unlicensedModuleMarksTheDocument() = kotlinx.coroutines.runBlocking {
        use(keyWith("forms"))
        PdfDocument.open(corpus("hello_world.pdf")).use { d ->
            org.junit.Assert.assertFalse(d.needsWatermark)
            d.page(0).addNote(PdfRect(10f, 10f, 30f, 30f), "x")
            org.junit.Assert.assertTrue(d.needsWatermark)
        }
    }

    @Test fun unlicensedRedactionStillRemovesText() = kotlinx.coroutines.runBlocking {
        use(keyWith(""))
        PdfDocument.open(corpus("hello_world.pdf")).use { d ->
            d.redact(listOf(PdfRedactionTarget.TextMatches("Hello")))
            val text = texts(d.toByteArray())[0]
            org.junit.Assert.assertFalse(text.contains("Hello"))
            org.junit.Assert.assertTrue(text.contains(mark))
        }
    }

    /** pdfsig runs on the host over this file; see scripts/test-android.sh. */
    @Test fun writesAnUnlicensedSignedDocumentForTheHost() = kotlinx.coroutines.runBlocking {
        use(keyWith(""))
        val signer = com.pdfiumkit.sign.Pkcs12Signer(assets.open("fixtures/test-signer.p12").use { it.readBytes() }, "pdfiumkit")
        val signed = PdfDocument.open(corpus("hello_world.pdf")).use { it.sign(com.pdfiumkit.sign.PdfSignOptions(signer)) }
        org.junit.Assert.assertTrue(texts(signed)[0].contains(mark))
        java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,
                     "pdfiumkit-android-trial-signed.pdf").writeBytes(signed)
    }
```

Match real names before running: `PdfRect` argument order in `Types.kt`, the redaction target class in `Redact.kt`, `Pkcs12Signer` and `PdfSignOptions` constructors in `SigningTest.kt:46`. Correct the calls to the names found.

- [ ] **Step 2: Run to verify they fail**

Run: `cd android && gradle :pdfiumkit:compileDebugAndroidTestKotlin --console=plain -q 2>&1 | grep "^e:" | head -3`
Expected: `Unresolved reference: needsWatermark`.

- [ ] **Step 3: Write the C++ watermark**

`watermark.h`:
```cpp
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>
#include "fpdfview.h"

/// Draws the trial watermark over an already rendered bitmap.
void pdfiumkit_draw_watermark(FPDF_BITMAP bitmap, int width, int height);

/// A full save of the document in `data` with the watermark in every page's content.
/// Empty when the bytes cannot be reopened or saved.
std::vector<uint8_t> pdfiumkit_stamp_watermark(const uint8_t* data, size_t size);
```

`watermark.cpp`:
```cpp
#include "watermark.h"

#include <cmath>
#include "fpdf_edit.h"
#include "fpdf_save.h"

namespace {

const char16_t kText[] = u"PdfiumKit trial";

void place(FPDF_DOCUMENT document, FPDF_PAGE page, float left, float bottom, float width, float height) {
    FPDF_PAGEOBJECT object = FPDFPageObj_NewTextObj(document, "Helvetica-Bold", 100.0f);
    if (!object) return;
    FPDFText_SetText(object, reinterpret_cast<FPDF_WIDESTRING>(kText));
    FPDFPageObj_SetFillColor(object, 128, 128, 128, 64);

    float l = 0, b = 0, r = 0, t = 0;
    FPDFPageObj_GetBounds(object, &l, &b, &r, &t);
    double angle = std::atan2(static_cast<double>(height), static_cast<double>(width));
    double scale = std::hypot(width, height) * 0.6 / std::max(1.0, static_cast<double>(r - l));
    double c = std::cos(angle) * scale;
    double s = std::sin(angle) * scale;
    FPDFPageObj_Transform(object, 1, 0, 0, 1, -(l + r) / 2.0, -(b + t) / 2.0);
    FPDFPageObj_Transform(object, c, s, -s, c, left + width / 2.0, bottom + height / 2.0);
    FPDFPage_InsertObject(page, object);
    FPDFPage_GenerateContent(page);
}

struct Collector {
    FPDF_FILEWRITE base;
    std::vector<uint8_t>* out;
};

int collect(FPDF_FILEWRITE* self, const void* data, unsigned long size) {
    auto* collector = reinterpret_cast<Collector*>(self);
    auto* bytes = static_cast<const uint8_t*>(data);
    collector->out->insert(collector->out->end(), bytes, bytes + size);
    return 1;
}

}  // namespace

void pdfiumkit_draw_watermark(FPDF_BITMAP bitmap, int width, int height) {
    FPDF_DOCUMENT scratch = FPDF_CreateNewDocument();
    if (!scratch) return;
    FPDF_PAGE page = FPDFPage_New(scratch, 0, width, height);
    if (page) {
        place(scratch, page, 0, 0, static_cast<float>(width), static_cast<float>(height));
        FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0);
        FPDF_ClosePage(page);
    }
    FPDF_CloseDocument(scratch);
}

std::vector<uint8_t> pdfiumkit_stamp_watermark(const uint8_t* data, size_t size) {
    std::vector<uint8_t> out;
    FPDF_DOCUMENT document = FPDF_LoadMemDocument(data, static_cast<int>(size), nullptr);
    if (!document) return out;
    int count = FPDF_GetPageCount(document);
    for (int index = 0; index < count; ++index) {
        FPDF_PAGE page = FPDF_LoadPage(document, index);
        if (!page) continue;
        float l = 0, b = 0, r = 0, t = 0;
        bool box = FPDFPage_GetMediaBox(page, &l, &b, &r, &t);
        place(document, page, box ? l : 0, box ? b : 0, FPDF_GetPageWidthF(page), FPDF_GetPageHeightF(page));
        FPDF_ClosePage(page);
    }
    Collector collector{};
    collector.base.version = 1;
    collector.base.WriteBlock = collect;
    collector.out = &out;
    if (!FPDF_SaveAsCopy(document, &collector.base, FPDF_NO_INCREMENTAL)) out.clear();
    FPDF_CloseDocument(document);
    return out;
}
```

Add `#include <algorithm>` for `std::max`. In `CMakeLists.txt`, add `watermark.cpp` next to `pdfiumkit_jni.cpp` in the library sources (`grep -n "pdfiumkit_jni.cpp" android/pdfiumkit/src/main/cpp/CMakeLists.txt`).

- [ ] **Step 4: Wire JNI and Kotlin**

In `pdfiumkit_jni.cpp`: `#include "watermark.h"`. Change the `renderPage` signature to add `jboolean watermark` after `jboolean drawForms`, and after the `if (drawForms && d->form) { … }` block, before the BGRA swap, add:
```cpp
    if (watermark) {
        pdfiumkit_draw_watermark(target, static_cast<int>(info.width), static_cast<int>(info.height));
    }
```
The watermark must be drawn before the channel swap so all pixels are swapped once.

Add a JNI function next to `saveDocument`:
```cpp
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_pdfiumkit_Native_stampWatermark(JNIEnv* env, jclass, jbyteArray bytes) {
    jsize size = env->GetArrayLength(bytes);
    std::vector<uint8_t> input(static_cast<size_t>(size));
    env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte*>(input.data()));
    std::vector<uint8_t> out = pdfiumkit_stamp_watermark(input.data(), input.size());
    jbyteArray result = env->NewByteArray(static_cast<jsize>(out.size()));
    if (!out.empty()) {
        env->SetByteArrayRegion(result, 0, static_cast<jsize>(out.size()), reinterpret_cast<const jbyte*>(out.data()));
    }
    return result;
}
```
If `saveDocument` sits inside an `extern "C" {` block, place the new function inside the same block without its own `extern "C"`.

In `Native.kt`: add `watermark: Boolean` as the last parameter of `renderPage`, and:
```kotlin
    @JvmStatic external fun stampWatermark(bytes: ByteArray): ByteArray
```

In `PdfDocument.kt`:
- imports: `import com.pdfiumkit.license.PdfLicense`, `import com.pdfiumkit.license.PdfLicenseModule`, `import com.pdfiumkit.license.PdfLicenseStatus`.
- After `private val closed = AtomicBoolean(false)` add:
```kotlin
    /** Set at open in trial mode, or by [use] when a feature is not licensed. */
    @Volatile internal var needsWatermark: Boolean = PdfLicense.status.isTrial
        private set

    /** Every paid entry point calls this first. The operation runs either way. */
    internal fun use(module: PdfLicenseModule) {
        if (!PdfLicense.status.covers(module)) needsWatermark = true
    }

    internal fun noteWatermarked() {
        val status = PdfLicense.status
        PdfLicense.noteWatermark(if (status is PdfLicenseStatus.Trial) status.message
                                 else "the license key does not cover every module used")
    }
```
- Replace `toByteArray`:
```kotlin
    /** Serialises the document. A document that needs the watermark is always saved in full. */
    suspend fun toByteArray(mode: PdfSaveMode = PdfSaveMode.FULL): ByteArray = onDocument { h ->
        if (!needsWatermark) {
            Native.saveDocument(h, mode.flag).also { if (it.isEmpty()) throw PdfError.SaveFailed("no bytes were produced") }
        } else {
            noteWatermarked()
            val full = Native.saveDocument(h, PdfSaveMode.FULL.flag)
            if (full.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
            Native.stampWatermark(full).also {
                if (it.isEmpty()) throw PdfError.SaveFailed("the saved document could not be watermarked")
            }
        }
    }
```
- In `PdfPage.setRotation`, first line: `document.use(PdfLicenseModule.EDITING)`.
- In `PdfPage.render(pixelWidth, pixelHeight, …)`, change the native call to pass `document.needsWatermark` and note it:
```kotlin
        val watermark = document.needsWatermark
        if (watermark) document.noteWatermarked()
        val ok = Native.renderPage(h, index, bitmap, options.toFlags(), background.toColorInt(),
            options.forms, watermark)
```

In `PageContent.kt`, add `document.use(PdfLicenseModule.EDITING)` as the first statement of `addInk`, `addNote`, `removeAnnotation`, and of whichever function `addHighlight`/`addUnderline`/`addStrikeout` delegate to (read lines 96–120; if they are expression bodies calling a private `addMarkup`, put it there). Add `document.use(PdfLicenseModule.FORMS)` as the first statement of `setText`, `setChecked`, `setOption`. Add the `PdfLicenseModule` import.

In `Redact.kt`, first statement of `PdfDocument.redact`: `use(PdfLicenseModule.REDACTION)`.

In `sign/Sign.kt`, in `PdfDocument.sign(options)`: first statement `use(PdfLicenseModule.SIGNING)`, then find where `originalBytes()` is passed to the signing routine and replace it with:
```kotlin
    val base = if (!needsWatermark) originalBytes() else onDocument {
        noteWatermarked()
        Native.stampWatermark(originalBytes()).also {
            if (it.isEmpty()) throw PdfError.SaveFailed("the document could not be watermarked")
        }
    }
```
Update the function's KDoc with the trial limitation sentence from Task 7 Step 5.

- [ ] **Step 5: Cross-check on the host**

In `scripts/test-android.sh`, pull `files/pdfiumkit-android-trial-signed.pdf` the same way as the existing file and run the same pdfsig checks; extract a `check_pdfsig <file> <label>` function so both use one implementation.

- [ ] **Step 6: Run the license test, then the gate**

Run: `cd android && ANDROID_SERIAL=emulator-5554 gradle :pdfiumkit:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.pdfiumkit.LicenseTest --console=plain -q 2>&1 | tail -5`
Expected: 8 tests pass.

Run: `ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh 2>&1 | grep -E "tests completed|FAILED|BUILD|cross-check" | tail -10`
Expected: everything passes; both pdfsig cross-checks pass.

- [ ] **Step 7: Commit**

```bash
git add android scripts/test-android.sh
git commit -m "Android: watermark rendering, saving and signing without a covering license"
```

---

### Task 11: Android AI trial prefix

**Files:**
- Create: `android/pdfiumkit-ai/src/main/java/com/pdfiumkit/ai/Trial.kt`, `android/pdfiumkit-ai/src/test/java/com/pdfiumkit/ai/TrialTest.kt`
- Modify: `android/pdfiumkit-ai/src/main/java/com/pdfiumkit/ai/PdfiumAI.kt` (`ask` and `summarize` returns)

**Interfaces:**
- Consumes: `PdfLicense.status.covers(PdfLicenseModule.AI)`.
- Produces: `internal object Trial { const val PREFIX: String; fun answer(outcome: PdfAiOutcome<PdfAnswer>, licensed: Boolean): PdfAiOutcome<PdfAnswer>; fun summary(outcome: PdfAiOutcome<PdfSummary>, licensed: Boolean): PdfAiOutcome<PdfSummary> }`

- [ ] **Step 1: Write the failing JVM test**

Check the JVM test folder first: `ls android/pdfiumkit-ai/src/test/java/com/pdfiumkit/ai/`.
```kotlin
package com.pdfiumkit.ai

import org.junit.Assert.assertEquals
import org.junit.Test

class TrialTest {
    @Test fun prefixesWithoutAnAiLicense() {
        val answer = PdfAiOutcome.Answered(PdfAiResult<PdfAnswer>(
            PdfAnswer.Answered("Yes.", emptyList(), true, emptyList()), PdfAiSource.RULES))
        val marked = Trial.answer(answer, licensed = false) as PdfAiOutcome.Answered
        assertEquals("PdfiumKit trial — Yes.", (marked.result.value as PdfAnswer.Answered).text)

        val summary = PdfAiOutcome.Answered(PdfAiResult(PdfSummary("Short.", emptyList()), PdfAiSource.RULES))
        assertEquals("Short.", (Trial.summary(summary, licensed = true) as PdfAiOutcome.Answered).result.value.text)
    }
}
```
Check the real property names first: `grep -n "class Answered\|val result\|val value\|val text" android/pdfiumkit-ai/src/main/java/com/pdfiumkit/ai/*.kt` and adjust `result`, `value`, `text`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && gradle :pdfiumkit-ai:testDebugUnitTest --tests com.pdfiumkit.ai.TrialTest --console=plain -q 2>&1 | grep -E "^e:|FAILED" | head -3`
Expected: `Unresolved reference: Trial`.

- [ ] **Step 3: Implement**

```kotlin
package com.pdfiumkit.ai

import android.util.Log
import com.pdfiumkit.license.PdfLicense
import com.pdfiumkit.license.PdfLicenseModule

/** Marks model output produced without an `ai` license. Quotes are never touched. */
internal object Trial {
    const val PREFIX = "PdfiumKit trial — "
    @Volatile private var warned = false

    private fun licensedNow() = PdfLicense.status.covers(PdfLicenseModule.AI)

    fun answer(outcome: PdfAiOutcome<PdfAnswer>, licensed: Boolean = licensedNow()): PdfAiOutcome<PdfAnswer> {
        if (licensed || outcome !is PdfAiOutcome.Answered) return outcome
        val value = outcome.result.value as? PdfAnswer.Answered ?: return outcome
        warn()
        return PdfAiOutcome.Answered(outcome.result.copy(value = value.copy(text = PREFIX + value.text)))
    }

    fun summary(outcome: PdfAiOutcome<PdfSummary>, licensed: Boolean = licensedNow()): PdfAiOutcome<PdfSummary> {
        if (licensed || outcome !is PdfAiOutcome.Answered) return outcome
        warn()
        return PdfAiOutcome.Answered(outcome.result.copy(value = outcome.result.value.copy(text = PREFIX + outcome.result.value.text)))
    }

    private fun warn() {
        if (warned) return
        warned = true
        try {
            Log.w("PdfiumKit", "AI output is marked as trial — the license key does not include the ai module")
        } catch (e: RuntimeException) {
            // android.util.Log is a stub in JVM unit tests.
        }
    }
}
```
`copy` requires `PdfAiResult`, `PdfAnswer.Answered` and `PdfSummary` to be data classes; `PdfSummary` is one (`Summaries.kt:5`). If `PdfAiResult` is not, construct a new one with its constructor.

In `PdfiumAI.kt`, wrap the value returned by `resolveRoutes(…)` in `ask` with `Trial.answer(…)` and in `summarize` with `Trial.summary(…)`. Leave the `NotFound` rules return as is.

- [ ] **Step 4: Run AI tests**

Run: `cd android && gradle :pdfiumkit-ai:testDebugUnitTest --console=plain -q 2>&1 | tail -3`
Expected: 27 existing + 1 pass.

The AI instrumented tests run without a key (their module keeps `AndroidJUnitRunner`), so real-model summaries carry the prefix. Run `ANDROID_SERIAL=R3GL607XFKV gradle :pdfiumkit-ai:connectedDebugAndroidTest` only if a phone is connected and unlocked; if an assertion compares the start of the text, strip `Trial.PREFIX` in that test.

- [ ] **Step 5: Commit**

```bash
git add android/pdfiumkit-ai
git commit -m "Android AI: mark answers and summaries without an ai license"
```

---

### Task 12: Production key, release date, docs, full gates

**Files:**
- Create: `scripts/set-release-date.sh`
- Modify: `web/src/license/build.ts`, `ios/Sources/PdfiumKit/License/PdfLicense.swift` (`LicenseBuild`), `android/pdfiumkit/src/main/java/com/pdfiumkit/license/PdfLicense.kt` (`LicenseBuild`), `README.md`, `docs/HANDOFF.md`, `docs/superpowers/specs/2026-09-15-licensing-design.md`

- [ ] **Step 1: Generate the production key pair — ask the user first**

This creates the private key that signs every customer key. Ask the user where to keep it. With their answer (default suggestion `~/.pdfiumkit-license`), run:
```bash
node tools/license/issue.mjs keygen --out <their directory>
```
Expected: prints `private key: …/license-private.pem` and `public key:  <base64url>`.

- [ ] **Step 2: Embed the public key**

Replace `REPLACED_IN_TASK_12` with the printed public key in the three `LicenseBuild` locations:
```bash
grep -rln REPLACED_IN_TASK_12 web/src ios/Sources android/pdfiumkit/src | xargs sed -i '' "s|REPLACED_IN_TASK_12|<public key>|"
grep -rn REPLACED_IN_TASK_12 web ios android || echo "none left"
```
Expected: `none left`.

- [ ] **Step 3: Write `scripts/set-release-date.sh`**

```bash
#!/usr/bin/env bash
# Writes the release date every license check compares a key's expiry against.
#
#   ./scripts/set-release-date.sh 2026-10-01
set -euo pipefail
cd "$(dirname "$0")/.."
date="${1:?usage: set-release-date.sh YYYY-MM-DD}"
[[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "not a YYYY-MM-DD date: $date" >&2; exit 1; }

sed -i '' -E "s/(RELEASE_DATE = ')[0-9-]+(')/\1$date\2/" web/src/license/build.ts
sed -i '' -E "s/(static let releaseDate = \")[0-9-]+(\")/\1$date\2/" ios/Sources/PdfiumKit/License/PdfLicense.swift
sed -i '' -E "s/(const val RELEASE_DATE = \")[0-9-]+(\")/\1$date\2/" android/pdfiumkit/src/main/java/com/pdfiumkit/license/PdfLicense.kt
grep -h "$date" web/src/license/build.ts ios/Sources/PdfiumKit/License/PdfLicense.swift \
    android/pdfiumkit/src/main/java/com/pdfiumkit/license/PdfLicense.kt | wc -l | grep -q 3 \
    || { echo "release date was not written to all three platforms" >&2; exit 1; }
echo "release date: $date"
```

Run: `chmod +x scripts/set-release-date.sh && ./scripts/set-release-date.sh 2026-09-15 && git diff --stat`
Expected: `release date: 2026-09-15`, no content change (already that date).

- [ ] **Step 4: Verify a production key end to end on web**

```bash
node tools/license/issue.mjs sign --private-key <their directory>/license-private.pem \
  --customer Smoke --modules editing --server --expires 2030-01-01 > /tmp/pdfiumkit-smoke-key.txt
cd web && npm run build && node -e '
  const { PdfLicense } = await import("./dist/index.js");
  const { readFileSync } = await import("node:fs");
  console.log(await PdfLicense.setKey(readFileSync("/tmp/pdfiumkit-smoke-key.txt", "utf8").trim()));
' --input-type=module
```
Expected: `{ kind: 'licensed', customer: 'Smoke', modules: [ 'editing' ] }`. Delete `/tmp/pdfiumkit-smoke-key.txt` afterwards.

- [ ] **Step 5: Document it**

`README.md`, add a "Licensing" section:
````markdown
## Licensing

Without a license key every feature works, and rendered pages, saved files and AI output
carry a "PdfiumKit trial" watermark. A key unlocks the modules it lists — `editing`,
`forms`, `signing`, `redaction`, `ai` — for the app IDs and web hosts it names. Viewing,
text, search, verifying signatures, the viewer and sync need only a valid key.

```swift
PdfLicense.setKey("pk1.…")                  // iOS, before opening documents
```
```kotlin
PdfLicense.setKey(context, "pk1.…")         // Android, in Application.onCreate
```
```ts
await PdfLicense.setKey('pk1.…');           // web, before opening documents or creating a PdfWorker
```

`PdfLicense.status` says whether the key is valid, which modules it covers, and why a key
was rejected. A key never makes the SDK throw.

While a document needs the watermark it is always saved in full, even when an incremental
save is requested, and signing it rewrites the file first — so signatures already in that
file no longer verify. A licensed document keeps both behaviours as documented above.

Keys are checked offline. The check deters use beyond a license; it is not copy protection.
````

`docs/HANDOFF.md`: add a row to the table in §1 — `| Licensing: offline keys, modules, trial watermark | Done, three platforms |` — and under §2 "Running things", how to issue a key (`tools/license/issue.mjs`), where the private key lives (the directory the user chose), and `scripts/set-release-date.sh` as a release step. Update the test counts in §1 from the final gate output.

Spec: in §1 of the licensing spec replace "today the Swift and web packages ship as source. Binary packaging is separate work (§10)." with "`scripts/package-all.sh` builds those binaries; the source packages give no protection."; in §5 change the web example to `await PdfLicense.setKey('pk1.…')` and add "On web, verification uses WebCrypto, which is asynchronous: `setKey` returns a promise, and opening a document waits for a pending check."; add the reason codes list from this plan's Global Constraints to §4.

- [ ] **Step 6: Run every gate**

```bash
(cd web && npm test 2>&1 | tail -4)
(cd web-ai && npm test 2>&1 | tail -4)
node --test tools/license/issue.test.mjs 2>&1 | tail -3
./scripts/test-ios.sh 2>&1 | grep -E "Executed|error:|cross-check|TEST FAILED" | tail -14
ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh 2>&1 | grep -E "tests completed|FAILED|BUILD|cross-check" | tail -10
./scripts/test-web-browser.sh 2>&1 | tail -3
```
Expected: every suite passes; four pdfsig cross-checks (iOS, iOS trial, Android, Android trial) pass. The browser viewer test runs in trial mode and must still pass; if it asserts on pixels, set the test key in its page the same way `license-setup.ts` does.

- [ ] **Step 7: Commit**

```bash
git add scripts/set-release-date.sh web/src/license/build.ts ios/Sources/PdfiumKit/License android/pdfiumkit/src/main/java/com/pdfiumkit/license README.md docs
git commit -m "Licensing: production public key, release date script, documentation"
```
