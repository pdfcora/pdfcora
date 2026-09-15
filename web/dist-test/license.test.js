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
            if (status.kind === 'licensed')
                assert.deepEqual([...status.modules].sort(), expected.modules);
            else
                assert.equal(status.reason, expected.reason, status.message);
        });
    }
});
//# sourceMappingURL=license.test.js.map