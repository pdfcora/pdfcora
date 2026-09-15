import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PdfAiUnavailableError, resolve } from '../dist/provider.js';

describe('provider resolution order', () => {
  // AICore refuses inference from a background app. Saying so tells the host what to do:
  // call again from the foreground, rather than configure something.
  test('a route that fails for a named reason reports that reason when nothing answers', async () => {
    const result = await resolve<string>({
      onDevice: async () => { throw new PdfAiUnavailableError('backgroundUseBlocked'); },
      customProvider: async () => { throw new Error('502'); },
    });
    assert.deepEqual(result, { kind: 'unavailable', reason: 'backgroundUseBlocked' });
  });

  test('a later route that answers still wins over a named failure', async () => {
    const result = await resolve<string>({
      onDevice: async () => { throw new PdfAiUnavailableError('backgroundUseBlocked'); },
      customProvider: async () => 'from-provider',
    });
    assert.deepEqual(result, { value: 'from-provider', source: 'customProvider' });
  });

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

  // On a real phone ML Kit threw on every call while reporting itself available, and the
  // caller was told to configure a provider. A failure is not a missing configuration.
  test('when a route throws and nothing answers, the reason is requestFailed, not noProvider', async () => {
    const result = await resolve<string>({
      onDevice: async () => { throw new Error('AICore error 30'); },
      customProvider: async () => null,
    });
    assert.deepEqual(result, { kind: 'unavailable', reason: 'requestFailed' });
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
