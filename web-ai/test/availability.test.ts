import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isUsable, unavailable } from '../dist/availability.js';

describe('availability', () => {
  test('only `available` is usable', () => {
    assert.equal(isUsable({ kind: 'available' }), true);
    assert.equal(isUsable({ kind: 'downloadable' }), false);
    assert.equal(isUsable({ kind: 'downloading', progress: 0.5 }), false);
    assert.equal(isUsable(unavailable('deviceNotEligible')), false);
  });

  test('an unavailable state always names a reason', () => {
    // AVL-5: the caller must be able to tell the user *why*, not just that it failed.
    assert.equal(unavailable('noProvider').reason, 'noProvider');
  });
});
