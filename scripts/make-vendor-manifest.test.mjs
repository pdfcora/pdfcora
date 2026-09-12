import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, hashFile } from './make-vendor-manifest.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'a.bin'), 'hello');
  return dir;
}

test('hashFile returns the sha256 of file contents', () => {
  const dir = fixture();
  // sha256("hello")
  assert.equal(
    hashFile(join(dir, 'sub', 'a.bin')),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  );
  rmSync(dir, { recursive: true });
});

test('buildManifest records mapped paths with size and hash', () => {
  const dir = fixture();
  const m = buildManifest(dir, [{ from: 'sub/a.bin', to: 'web/a.bin' }]);
  assert.equal(m.engine.revision, 'chromium/7243');
  assert.equal(m.artifacts['web/a.bin'].bytes, 5);
  assert.equal(m.artifacts['web/a.bin'].sha256.length, 64);
  assert.equal(Object.keys(m.artifacts).length, 1);
  rmSync(dir, { recursive: true });
});

test('buildManifest throws a named error when a source file is missing', () => {
  const dir = fixture();
  assert.throws(
    () => buildManifest(dir, [{ from: 'nope.bin', to: 'web/nope.bin' }]),
    /missing artifact: nope\.bin/
  );
  rmSync(dir, { recursive: true });
});
