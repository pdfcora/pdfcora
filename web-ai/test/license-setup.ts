import { readFileSync } from 'node:fs';
// Relative, not through the package name: the package exports only its public entry points.
import { configureLicenseForTesting } from '../../web/dist/license/state.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));

// Every test process runs licensed for every module.
await configureLicenseForTesting({
  publicKey: FIXTURE.publicKey, revoked: FIXTURE.revoked, releaseDate: FIXTURE.releaseDate,
  host: null, key: FIXTURE.fullKey,
});
