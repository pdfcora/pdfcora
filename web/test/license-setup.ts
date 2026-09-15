import { readFileSync } from 'node:fs';
import { configureLicenseForTesting } from '../dist/license/state.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));

// Every test process runs licensed for every module; license tests change this locally.
await configureLicenseForTesting({
  publicKey: FIXTURE.publicKey, revoked: FIXTURE.revoked, releaseDate: FIXTURE.releaseDate,
  host: null, key: FIXTURE.fullKey,
});
