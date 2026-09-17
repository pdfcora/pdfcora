import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialText, TRIAL_PREFIX } from '../dist/trial.js';

test('without an ai license the text is prefixed', () => {
  assert.equal(TRIAL_PREFIX, 'PDFCora trial — ');
  assert.equal(trialText('An answer.', false), 'PDFCora trial — An answer.');
  assert.equal(trialText('An answer.', true), 'An answer.');
});
