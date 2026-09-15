import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPatterns } from '../dist/redaction/patterns.js';

const CASES = JSON.parse(readFileSync(new URL('../../conformance/redaction/patterns.json', import.meta.url), 'utf8'));

for (const c of CASES) {
  test(`patterns: ${c.text}`, () => {
    const found = findPatterns(c.text).map((m) => [m.category, c.text.slice(m.start, m.end)]);
    assert.deepEqual(found, c.expected);
  });
}

test('categories restrict what is looked for', () => {
  const text = 'anna@example.com 4111 1111 1111 1111';
  assert.deepEqual(findPatterns(text, new Set(['email'])).map((m) => m.category), ['email']);
});
