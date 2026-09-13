import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from '../dist/provider.js';

describe('provider resolution order', () => {
  test('routes are tried in order and the winner is named', async () => {
    const calls: string[] = [];
    const result = await resolve<string>({
      onDevice: async () => { calls.push('onDevice'); return null; },
      customProvider: async () => { calls.push('provider'); return 'from-provider'; },
      rules: async () => { calls.push('rules'); return 'from-rules'; },
    });

    assert.deepEqual(calls, ['onDevice', 'provider'],
      'the rules fallback must not run once a provider answered');
    assert.deepEqual(result, { value: 'from-provider', source: 'customProvider' });
  });

  test('with every route empty the result is unavailable, not an exception', async () => {
    const result = await resolve<string>({
      onDevice: async () => null, customProvider: async () => null, rules: async () => null,
    });
    assert.deepEqual(result, { kind: 'unavailable', reason: 'noProvider' });
  });

  test('a route that throws does not stop the next one', async () => {
    // A provider is someone else's server. It failing must not take the feature down
    // when a rules fallback exists.
    const result = await resolve<string>({
      onDevice: async () => null,
      customProvider: async () => { throw new Error('502'); },
      rules: async () => 'from-rules',
    });
    assert.deepEqual(result, { value: 'from-rules', source: 'rules' });
  });

  test('on-device wins outright when it answers', async () => {
    const calls: string[] = [];
    const result = await resolve<string>({
      onDevice: async () => { calls.push('onDevice'); return 'local'; },
      customProvider: async () => { calls.push('provider'); return 'remote'; },
    });
    // PRV-2's order exists so document content stays on the device when it can.
    assert.deepEqual(calls, ['onDevice']);
    assert.deepEqual(result, { value: 'local', source: 'onDevice' });
  });
});
