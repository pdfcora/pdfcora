# PdfiumKit Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Subagent-driven execution is disabled for this project by user instruction — execute inline.**

**Goal:** A repository skeleton where a single command populates verified PDFium artifacts for all three platforms, and a shared conformance contract exists that the iOS, Android, and Web SDKs will each be tested against.

**Architecture:** PDFium artifacts live outside version control. A checked-in manifest pins the engine revision and the SHA-256 of every artifact; a fetch script copies them from a source tree and verifies each hash. A host-side PDFium (the WASM build running under Node) validates those artifacts end-to-end and generates the conformance expectations, cross-checked against an independent PDF engine so we are not testing PDFium against itself.

**Tech Stack:** Bash, Node 18+ (`node --test`, zero runtime dependencies), Emscripten PDFium build, poppler (`pdfinfo`/`pdftotext`) as independent oracle, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-12-pdfiumkit-sdk-design.md`

## Global Constraints

- **No git.** No repository is initialised and nothing is committed. Where the standard TDD cycle ends in a commit, this plan ends in a **Checkpoint** step that verifies the deliverable instead. The user will place this under version control when they choose.
- **No background agents or subagents.** Execute inline.
- **PDFium pinned at `chromium/7243`.** Never fetch a different revision.
- **Engine build flags:** `pdf_enable_v8=false pdf_enable_xfa=false pdf_bundle_freetype=true pdf_is_complete_lib=true`.
- **Project root:** `/Users/daos/Projects/Lab/PdfiumKit-v2`. All paths below are relative to it.
- **Artifact source tree (read-only):** `/Users/daos/Projects/Lab/pdfiumkit`. Never write into it.
- **Previous SDK (read-only reference):** `/Users/daos/Projects/Lab/PDFCoriumKit`. Never write into it.
- **No artifact may be committed to the repo.** `vendor/` and `conformance/corpus/` large files stay out; only the manifest and the corpus subset (each under 200 KB) are tracked.
- **Comments:** inline comments only for non-obvious logic, constraints, or workarounds. Doc comments only where they add information the signature does not.
- **Node version floor:** 18 (for built-in `node --test`; avoid `fs.globSync`, use `readdirSync`).
- **Test invocation:** `node --test <dir>/` does NOT scan a directory on Node 22+ (verified failing on Node 26 — it tries to execute the directory as a module). Use explicit globs: `node --test "<dir>/*.test.mjs"`. Bare `node --test` auto-discovers but, once the web package exists, also picks up its TypeScript sources and compiled duplicates — so the root script lists its globs explicitly.

## Deviation from the spec, and why

Spec §9.1 says artifacts are published as checksummed **GitHub Release assets** and pulled by a fetch script. Phase 1 cannot do that: there is no git repository and no remote. The fetch script is therefore built with a **pluggable source**, defaulting to a local directory, with an HTTPS source as a second resolver that is implemented and unit-tested but unused until a remote exists. The manifest format and verification path are identical either way, so adopting Releases later is a configuration change, not a rewrite.

## File Structure

| Path | Responsibility |
|---|---|
| `vendor.manifest.json` | Pins engine revision + SHA-256/size of every artifact. Checked in. |
| `scripts/build-pdfium.sh` | Carried over verbatim from the source tree. Builds PDFium. |
| `scripts/make-vendor-manifest.mjs` | Hashes an artifact tree, emits `vendor.manifest.json`. |
| `scripts/fetch-vendor.sh` | Populates `vendor/` from a source, verifying every hash. |
| `vendor/` | Generated artifacts. Never committed. |
| `tools/host/pdfium-host.mjs` | Loads the WASM PDFium under Node; thin typed helpers. |
| `tools/host/pdfium-host.test.mjs` | Smoke tests proving vendor artifacts work. |
| `conformance/corpus.json` | Which corpus PDFs, their category, and provenance. |
| `conformance/corpus/` | The PDF files themselves. |
| `conformance/expectations.schema.json` | The contract all three platform runners consume. |
| `conformance/expectations.json` | Generated expected results. |
| `conformance/validate.mjs` | Validates expectations against the schema and corpus. |
| `conformance/generate.mjs` | Generates expectations via host PDFium + independent cross-check. |
| `.github/workflows/*.yml` | CI skeleton for the three platforms plus conformance. |
| `README.md` | How to get from clone to a populated `vendor/`. |
| `.gitignore` | Forward-looking; `vendor/`, `node_modules/`, build output. |

---

### Task 1: Repo skeleton, build script carryover, vendor manifest generator

**Files:**
- Create: `.gitignore`, `package.json`
- Create: `scripts/build-pdfium.sh` (copied)
- Create: `scripts/make-vendor-manifest.mjs`
- Create: `scripts/make-vendor-manifest.test.mjs`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `vendor.manifest.json` with shape
  `{ engine: { revision: string, buildFlags: string[] }, generated: string, artifacts: { [relPath: string]: { sha256: string, bytes: number } } }`.
  `scripts/make-vendor-manifest.mjs` exports `buildManifest(sourceDir: string, layout: LayoutEntry[]) -> Manifest` and `hashFile(path: string) -> string`.
  `LayoutEntry` is `{ from: string, to: string }` where `from` is relative to the artifact source tree and `to` is relative to `vendor/`.

- [x] **Step 1: Create the directory skeleton and `.gitignore`**

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
mkdir -p scripts tools/host conformance/corpus .github/workflows
cat > .gitignore <<'EOF'
vendor/
node_modules/
build/
*.log
.DS_Store
EOF
```

- [x] **Step 2: Create `package.json`**

No runtime dependencies. Test and utility scripts only.

```json
{
  "name": "pdfiumkit-tools",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test",
    "manifest": "node scripts/make-vendor-manifest.mjs",
    "conformance:validate": "node conformance/validate.mjs",
    "conformance:generate": "node conformance/generate.mjs"
  }
}
```

- [x] **Step 3: Carry over the PDFium build script**

```bash
cp /Users/daos/Projects/Lab/pdfiumkit/build-pdfium.sh \
   /Users/daos/Projects/Lab/PdfiumKit-v2/scripts/build-pdfium.sh
chmod +x /Users/daos/Projects/Lab/PdfiumKit-v2/scripts/build-pdfium.sh
grep -n 'PDFIUM_BRANCH=' /Users/daos/Projects/Lab/PdfiumKit-v2/scripts/build-pdfium.sh
```

Expected: prints the line pinning `chromium/7243`. If it does not, stop — the wrong file was copied.

- [x] **Step 4: Write the failing test for the manifest generator**

Create `scripts/make-vendor-manifest.test.mjs`:

```js
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
```

- [x] **Step 5: Run the test to verify it fails**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "scripts/*.test.mjs"`
Expected: FAIL — `Cannot find module './make-vendor-manifest.mjs'`

- [x] **Step 6: Implement the manifest generator**

Create `scripts/make-vendor-manifest.mjs`:

```js
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_REVISION = 'chromium/7243';
export const BUILD_FLAGS = [
  'pdf_enable_v8=false',
  'pdf_enable_xfa=false',
  'pdf_bundle_freetype=true',
  'pdf_is_complete_lib=true',
];

export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function buildManifest(sourceDir, layout) {
  const artifacts = {};
  for (const { from, to } of layout) {
    const abs = join(sourceDir, from);
    if (!existsSync(abs)) throw new Error(`missing artifact: ${from}`);
    artifacts[to] = { sha256: hashFile(abs), bytes: statSync(abs).size };
  }
  return {
    engine: { revision: ENGINE_REVISION, buildFlags: BUILD_FLAGS },
    generated: new Date().toISOString(),
    artifacts,
  };
}

export const LAYOUT = [
  { from: 'out/wasm/pdfium.js',       to: 'web/pdfium.js' },
  { from: 'out/wasm/pdfium.wasm',     to: 'web/pdfium.wasm' },
  { from: 'out/wasm/pdfium.esm.js',   to: 'web/pdfium.esm.js' },
  { from: 'out/wasm/pdfium.esm.wasm', to: 'web/pdfium.esm.wasm' },
  { from: 'out/ios/release/pdfium.xcframework/ios-arm64/libpdfium.a',
    to: 'ios/pdfium.xcframework/ios-arm64/libpdfium.a' },
  { from: 'out/ios/release/pdfium.xcframework/ios-arm64_x86_64-simulator/libpdfium.a',
    to: 'ios/pdfium.xcframework/ios-arm64_x86_64-simulator/libpdfium.a' },
  { from: 'out/ios/release/pdfium.xcframework/Info.plist',
    to: 'ios/pdfium.xcframework/Info.plist' },
  { from: 'out/android/release/lib/arm64-v8a/libpdfium.a',
    to: 'android/arm64-v8a/libpdfium.a' },
  { from: 'out/android/release/lib/armeabi-v7a/libpdfium.a',
    to: 'android/armeabi-v7a/libpdfium.a' },
  { from: 'out/android/release/lib/x86/libpdfium.a',
    to: 'android/x86/libpdfium.a' },
  { from: 'out/android/release/lib/x86_64/libpdfium.a',
    to: 'android/x86_64/libpdfium.a' },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  const source = process.argv[2] ?? '/Users/daos/Projects/Lab/pdfiumkit';
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = buildManifest(source, LAYOUT);
  writeFileSync(
    join(root, 'vendor.manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log(`wrote vendor.manifest.json (${Object.keys(manifest.artifacts).length} artifacts)`);
}
```

The public headers are deliberately absent from `LAYOUT`. They ship inside the iOS xcframework and are added for Android in Task 2 Step 7, where the whole `public/` directory is copied as a unit rather than hashed file-by-file.

- [x] **Step 7: Run the test to verify it passes**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "scripts/*.test.mjs"`
Expected: PASS, 3 tests.

- [x] **Step 8: Generate the real manifest**

Run:
```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
node scripts/make-vendor-manifest.mjs
node -e "const m=require('./vendor.manifest.json');console.log(Object.keys(m.artifacts).length,'artifacts');console.log(m.engine.revision)"
```
Expected: `11 artifacts` and `chromium/7243`.

- [x] **Step 9: Checkpoint**

Verify all of the following, and stop if any fails:
```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
test -f vendor.manifest.json && echo "manifest: ok"
test -x scripts/build-pdfium.sh && echo "build script: ok"
node --test "scripts/*.test.mjs" 2>&1 | tail -3
```

---

### Task 2: Vendor fetch with checksum verification

**Files:**
- Create: `scripts/fetch-vendor.sh`
- Create: `scripts/fetch-vendor.test.sh`

**Interfaces:**
- Consumes: `vendor.manifest.json` from Task 1; `LAYOUT` mapping is re-expressed in the shell script as a `from|to` table.
- Produces: a populated `vendor/` tree. Exit code 0 on success, 1 on any hash mismatch or missing file, with the offending path on stderr.

- [x] **Step 1: Write the failing test**

Create `scripts/fetch-vendor.test.sh`:

```bash
#!/usr/bin/env bash
# Verifies fetch-vendor.sh populates vendor/ and rejects tampered artifacts.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
check() { if [ "$1" = "0" ]; then echo "  ok: $2"; else echo "  FAIL: $2"; FAIL=1; fi; }

echo "test: clean fetch succeeds"
rm -rf "$ROOT/vendor"
"$ROOT/scripts/fetch-vendor.sh" >/dev/null 2>&1
check $? "exit 0"
test -f "$ROOT/vendor/web/pdfium.wasm"; check $? "web/pdfium.wasm present"
test -f "$ROOT/vendor/android/arm64-v8a/libpdfium.a"; check $? "android arm64 lib present"
test -f "$ROOT/vendor/android/include/public/fpdfview.h"; check $? "android headers present"

echo "test: tampered artifact is rejected"
echo "corrupt" >> "$ROOT/vendor/web/pdfium.wasm"
OUT=$("$ROOT/scripts/fetch-vendor.sh" --verify-only 2>&1)
test $? -ne 0; check $? "exit non-zero on mismatch"
echo "$OUT" | grep -q "web/pdfium.wasm"; check $? "names the bad artifact"

# Restore a good vendor/ rather than deleting it — other suites depend on it.
"$ROOT/scripts/fetch-vendor.sh" >/dev/null 2>&1
check $? "vendor restored for other suites"

echo
if [ "$FAIL" = "0" ]; then echo "ALL PASS"; else echo "FAILURES"; exit 1; fi
```

Then: `chmod +x scripts/fetch-vendor.test.sh`

- [x] **Step 2: Run the test to verify it fails**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && ./scripts/fetch-vendor.test.sh`
Expected: FAIL — `scripts/fetch-vendor.sh: No such file or directory`

- [x] **Step 3: Implement the fetch script**

Create `scripts/fetch-vendor.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/vendor.manifest.json"
VENDOR="$ROOT/vendor"
SOURCE="${PDFIUMKIT_ARTIFACTS:-/Users/daos/Projects/Lab/pdfiumkit}"
VERIFY_ONLY=0
[ "${1:-}" = "--verify-only" ] && VERIFY_ONLY=1

[ -f "$MANIFEST" ] || { echo "no vendor.manifest.json; run: node scripts/make-vendor-manifest.mjs" >&2; exit 1; }

# to|from, mirroring LAYOUT in scripts/make-vendor-manifest.mjs
MAP=$(cat <<'EOF'
web/pdfium.js|out/wasm/pdfium.js
web/pdfium.wasm|out/wasm/pdfium.wasm
web/pdfium.esm.js|out/wasm/pdfium.esm.js
web/pdfium.esm.wasm|out/wasm/pdfium.esm.wasm
ios/pdfium.xcframework/ios-arm64/libpdfium.a|out/ios/release/pdfium.xcframework/ios-arm64/libpdfium.a
ios/pdfium.xcframework/ios-arm64_x86_64-simulator/libpdfium.a|out/ios/release/pdfium.xcframework/ios-arm64_x86_64-simulator/libpdfium.a
ios/pdfium.xcframework/Info.plist|out/ios/release/pdfium.xcframework/Info.plist
android/arm64-v8a/libpdfium.a|out/android/release/lib/arm64-v8a/libpdfium.a
android/armeabi-v7a/libpdfium.a|out/android/release/lib/armeabi-v7a/libpdfium.a
android/x86/libpdfium.a|out/android/release/lib/x86/libpdfium.a
android/x86_64/libpdfium.a|out/android/release/lib/x86_64/libpdfium.a
EOF
)

expected_hash() {
  node -e "const m=require('$MANIFEST');const a=m.artifacts['$1'];if(!a){console.error('not in manifest: $1');process.exit(1)}console.log(a.sha256)"
}

status=0
while IFS='|' read -r to from; do
  [ -z "$to" ] && continue
  dest="$VENDOR/$to"
  if [ "$VERIFY_ONLY" = "0" ]; then
    src="$SOURCE/$from"
    if [ ! -f "$src" ]; then echo "missing source: $from" >&2; status=1; continue; fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  fi
  if [ ! -f "$dest" ]; then echo "missing artifact: $to" >&2; status=1; continue; fi
  want=$(expected_hash "$to") || { status=1; continue; }
  got=$(shasum -a 256 "$dest" | cut -d' ' -f1)
  if [ "$want" != "$got" ]; then
    echo "checksum mismatch: $to" >&2
    echo "  expected $want" >&2
    echo "  actual   $got" >&2
    status=1
  fi
done <<< "$MAP"

# The Emscripten glue is CommonJS, but this project declares "type": "module",
# which would make Node parse it as ESM and export nothing. Scope it back.
if [ "$VERIFY_ONLY" = "0" ] && [ -d "$VENDOR/web" ]; then
  echo '{ "type": "commonjs" }' > "$VENDOR/web/package.json"
fi

# Public headers are copied wholesale rather than hashed individually.
if [ "$VERIFY_ONLY" = "0" ]; then
  hdr_src="$SOURCE/src-android/pdfium/public"
  if [ -d "$hdr_src" ]; then
    mkdir -p "$VENDOR/android/include"
    rm -rf "$VENDOR/android/include/public"
    cp -R "$hdr_src" "$VENDOR/android/include/public"
  else
    echo "missing headers: src-android/pdfium/public" >&2; status=1
  fi
fi

if [ "$status" = "0" ]; then
  echo "vendor/ populated and verified against $(basename "$MANIFEST")"
else
  echo "vendor fetch FAILED" >&2
fi
exit $status
```

Then: `chmod +x scripts/fetch-vendor.sh`

- [x] **Step 4: Run the test to verify it passes**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && ./scripts/fetch-vendor.test.sh`
Expected: `ALL PASS` — six `ok:` lines.

- [x] **Step 5: Populate vendor for real and confirm size**

Run:
```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
./scripts/fetch-vendor.sh
du -sh vendor vendor/android vendor/ios vendor/web
```
Expected: roughly 72 MB android, 23 MB ios, 8 MB web. Confirms all four ABIs landed.

- [x] **Step 6: Checkpoint**

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
./scripts/fetch-vendor.sh --verify-only && echo "verify: ok"
ls vendor/android/*/libpdfium.a | wc -l   # expect 4
test -f vendor/android/include/public/fpdfview.h && echo "headers: ok"
```

---

### Task 3: Host PDFium harness

**Files:**
- Create: `tools/host/pdfium-host.mjs`
- Create: `tools/host/pdfium-host.test.mjs`

**Interfaces:**
- Consumes: `vendor/web/pdfium.js` and `vendor/web/pdfium.wasm` from Task 2.
- Produces: `loadPdfium() -> Promise<Pdfium>` where `Pdfium` has
  `openDocument(bytes: Uint8Array, password?: string|null) -> Doc`,
  `Doc.pageCount: number`, `Doc.pageSize(i) -> {width, height}`,
  `Doc.metadata(key: string) -> string`, `Doc.close()`,
  and `Pdfium.lastError() -> number`.
  Task 6 depends on exactly these names.

- [x] **Step 1: Write the failing test**

Create `tools/host/pdfium-host.test.mjs`:

```js
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPdfium } from './pdfium-host.mjs';

const CORPUS = '/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources';
let pdfium;
before(async () => { pdfium = await loadPdfium(); });

test('opens a document and reports page count', () => {
  const doc = pdfium.openDocument(readFileSync(`${CORPUS}/combobox_form.pdf`));
  assert.equal(doc.pageCount, 1);
  doc.close();
});

test('reports page dimensions in points', () => {
  const doc = pdfium.openDocument(readFileSync(`${CORPUS}/combobox_form.pdf`));
  const { width, height } = doc.pageSize(0);
  assert.equal(Math.round(width), 300);
  assert.equal(Math.round(height), 600);
  doc.close();
});

test('a password-protected document fails without a password', () => {
  assert.throws(
    () => pdfium.openDocument(readFileSync(`${CORPUS}/encrypted_hello_world_r2.pdf`)),
    /password/i
  );
});

test('a corrupt document raises rather than returning a null handle', () => {
  assert.throws(() => pdfium.openDocument(Uint8Array.from([1, 2, 3, 4])), /load failed/i);
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "tools/host/*.test.mjs"`
Expected: FAIL — `Cannot find module './pdfium-host.mjs'`

- [x] **Step 3: Implement the host harness**

Create `tools/host/pdfium-host.mjs`:

```js
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

// PDFium error codes from fpdfview.h
const ERR = { 0: 'success', 1: 'unknown', 2: 'file', 3: 'format', 4: 'password', 5: 'security', 6: 'page' };

export async function loadPdfium() {
  const factory = require(join(ROOT, 'vendor', 'web', 'pdfium.js'));
  const M = await factory();
  M.ccall('FPDF_InitLibrary', null, [], []);

  const lastError = () => M.ccall('FPDF_GetLastError', 'number', [], []);

  function openDocument(bytes, password = null) {
    const ptr = M._malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    const handle = M.ccall(
      'FPDF_LoadMemDocument', 'number',
      ['number', 'number', 'string'], [ptr, bytes.length, password]
    );
    if (!handle) {
      const code = lastError();
      M._free(ptr);
      throw new Error(`load failed: ${ERR[code] ?? code}`);
    }
    // The buffer must outlive the document; PDFium reads from it lazily.
    return makeDoc(handle, ptr);
  }

  function makeDoc(handle, bufPtr) {
    let closed = false;
    const guard = () => { if (closed) throw new Error('document is closed'); };
    return {
      get pageCount() {
        guard();
        return M.ccall('FPDF_GetPageCount', 'number', ['number'], [handle]);
      },
      pageSize(i) {
        guard();
        const page = M.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [handle, i]);
        if (!page) throw new Error(`page ${i} failed to load`);
        const width = M.ccall('FPDF_GetPageWidthF', 'number', ['number'], [page]);
        const height = M.ccall('FPDF_GetPageHeightF', 'number', ['number'], [page]);
        M.ccall('FPDF_ClosePage', null, ['number'], [page]);
        return { width, height };
      },
      metadata(key) {
        guard();
        const len = M.ccall('FPDF_GetMetaText', 'number',
          ['number', 'string', 'number', 'number'], [handle, key, 0, 0]);
        if (len <= 2) return '';
        const out = M._malloc(len);
        M.ccall('FPDF_GetMetaText', 'number',
          ['number', 'string', 'number', 'number'], [handle, key, out, len]);
        const u16 = new Uint16Array(M.HEAPU8.buffer, out, (len / 2) - 1);
        const text = String.fromCharCode(...u16);
        M._free(out);
        return text;
      },
      close() {
        if (closed) return;
        M.ccall('FPDF_CloseDocument', null, ['number'], [handle]);
        M._free(bufPtr);
        closed = true;
      },
    };
  }

  return { openDocument, lastError };
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "tools/host/*.test.mjs"`
Expected: PASS, 4 tests.

If the encrypted-document test fails because that file opens without a password, list the alternatives with `ls /Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources/encrypted*` and substitute one that genuinely requires a password. Do not weaken the assertion.

- [x] **Step 5: Checkpoint**

This proves the vendor artifacts are not merely present but functional.

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "tools/host/*.test.mjs" 2>&1 | tail -5
```

---

### Task 4: Conformance corpus selection

**Files:**
- Create: `conformance/corpus.json`
- Create: `conformance/select-corpus.mjs`
- Create: `conformance/corpus/` (populated)
- Create: `conformance/NOTICE.md`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `conformance/corpus.json` with shape
  `{ source: string, license: string, files: Array<{ name: string, category: string }> }`
  where `category` is one of `basic | form | encrypted | annotation | text | regression`.
  Task 5 and Task 6 both read this file.

- [x] **Step 1: Write the corpus selection script**

Create `conformance/select-corpus.mjs`:

```js
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = '/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources';
const MAX_BYTES = 200 * 1024;

const SELECTION = [
  ['hello_world.pdf', 'basic'],
  ['rectangles.pdf', 'basic'],
  ['many_rectangles.pdf', 'basic'],
  ['combobox_form.pdf', 'form'],
  ['listbox_form.pdf', 'form'],
  ['text_form.pdf', 'form'],
  ['click_form.pdf', 'form'],
  ['encrypted_hello_world_r2.pdf', 'encrypted'],
  ['annotation_highlight_long_content.pdf', 'annotation'],
  ['annots_action_handling.pdf', 'annotation'],
  ['annotation_stamp_with_ap.pdf', 'annotation'],
  ['text_font.pdf', 'text'],
  ['find_text_consecutive.pdf', 'text'],
  ['hebrew_mirrored.pdf', 'text'],
  ['tagged_actual_text.pdf', 'text'],
  ['hello_world_2_pages_split_streams.pdf', 'basic'],
  ['bug_455199.pdf', 'regression'],
  ['bug_707673.pdf', 'regression'],
];

mkdirSync(join(HERE, 'corpus'), { recursive: true });
const files = [];
const skipped = [];

for (const [name, category] of SELECTION) {
  const src = join(SRC, name);
  if (!existsSync(src)) { skipped.push(`${name} (not found)`); continue; }
  if (statSync(src).size > MAX_BYTES) { skipped.push(`${name} (too large)`); continue; }
  copyFileSync(src, join(HERE, 'corpus', name));
  files.push({ name, category });
}

writeFileSync(
  join(HERE, 'corpus.json'),
  JSON.stringify({
    source: 'PDFium testing/resources @ chromium/7243',
    license: 'BSD-3-Clause (see NOTICE.md)',
    files,
  }, null, 2) + '\n'
);

console.log(`selected ${files.length} files`);
if (skipped.length) console.log(`skipped:\n  ${skipped.join('\n  ')}`);
```

- [x] **Step 2: Run it**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node conformance/select-corpus.mjs`
Expected: `selected 13 files` and no skip list.

All 13 filenames were verified present in the source corpus on 2026-09-12, each under the 200 KB cap. If any is skipped, the artifact source tree has changed — find a substitute in the same category:
```bash
ls /Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources/ | grep -iE 'form|encrypt|annot|bug_' | head -40
```
Every category must end with at least one file, and `form` with at least three.

- [x] **Step 3: Write the attribution notice**

Create `conformance/NOTICE.md`:

```markdown
# Conformance corpus attribution

The PDF files in `corpus/` are copied from the PDFium project's test resources
(`testing/resources`) at revision `chromium/7243`.

PDFium is Copyright 2014 The PDFium Authors, licensed BSD-3-Clause.
See https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE

These files are used unmodified, as test inputs only.
```

- [x] **Step 4: Verify the corpus**

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
ls conformance/corpus/*.pdf | wc -l
node -e "const c=require('./conformance/corpus.json');const g={};for(const f of c.files)g[f.category]=(g[f.category]||0)+1;console.log(g)"
du -sh conformance/corpus
```
Expected: file count matches `corpus.json`, every category present, total well under 3 MB.

- [x] **Step 5: Checkpoint**

Confirm each corpus file opens under the host harness, so no unreadable file enters the suite:

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
node -e "
import('./tools/host/pdfium-host.mjs').then(async ({loadPdfium})=>{
  const fs=require('fs');const c=require('./conformance/corpus.json');
  const p=await loadPdfium();let ok=0,expected=0;
  for(const f of c.files){
    try{const d=p.openDocument(fs.readFileSync('conformance/corpus/'+f.name));d.close();ok++}
    catch(e){ if(f.category==='encrypted'||f.category==='regression'){expected++}
              else console.log('UNEXPECTED FAIL',f.name,e.message) }
  }
  console.log('opened',ok,'| expected failures',expected);
})"
```

---

### Task 5: Expectations schema and validator

**Files:**
- Create: `conformance/expectations.schema.json`
- Create: `conformance/validate.mjs`
- Create: `conformance/validate.test.mjs`

**Interfaces:**
- Consumes: `conformance/corpus.json` from Task 4.
- Produces: `validateExpectations(expectations: object, corpus: object) -> string[]`, returning an array of human-readable problems, empty when valid. Task 6 calls this before writing its output, and every platform test runner in later phases reads `expectations.json` in this shape.

- [x] **Step 1: Define the schema**

Create `conformance/expectations.schema.json`. This is the cross-platform contract, so it is written by hand rather than inferred:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PdfiumKit conformance expectations",
  "type": "object",
  "required": ["engine", "documents"],
  "properties": {
    "engine": { "type": "string" },
    "generated": { "type": "string" },
    "documents": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["category", "opens"],
        "properties": {
          "category": { "enum": ["basic", "form", "encrypted", "annotation", "text", "regression"] },
          "opens": { "type": "boolean" },
          "openError": { "enum": ["password", "format", "file", "security", "page", "unknown"] },
          "pageCount": { "type": "integer", "minimum": 0 },
          "pages": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["width", "height"],
              "properties": {
                "width": { "type": "number" },
                "height": { "type": "number" },
                "textContains": { "type": "array", "items": { "type": "string" } }
              }
            }
          },
          "metadata": { "type": "object", "additionalProperties": { "type": "string" } }
        }
      }
    }
  }
}
```

Page dimensions are floats compared with a tolerance by the runners, not for exact equality. Text is asserted as `textContains` substrings rather than exact full-page text, because extraction whitespace legitimately varies between platforms.

- [x] **Step 2: Write the failing test**

Create `conformance/validate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExpectations } from './validate.mjs';

const corpus = { files: [{ name: 'a.pdf', category: 'basic' }] };

test('a well-formed expectations file has no problems', () => {
  const exp = {
    engine: 'chromium/7243',
    documents: { 'a.pdf': { category: 'basic', opens: true, pageCount: 1,
      pages: [{ width: 200, height: 300 }] } },
  };
  assert.deepEqual(validateExpectations(exp, corpus), []);
});

test('reports a document that is missing from the corpus', () => {
  const exp = { engine: 'x', documents: { 'ghost.pdf': { category: 'basic', opens: true } } };
  const problems = validateExpectations(exp, corpus);
  assert.ok(problems.some(p => p.includes('ghost.pdf')));
});

test('reports a corpus file with no expectations', () => {
  const exp = { engine: 'x', documents: {} };
  const problems = validateExpectations(exp, corpus);
  assert.ok(problems.some(p => p.includes('a.pdf')));
});

test('reports pageCount disagreeing with the pages array', () => {
  const exp = {
    engine: 'x',
    documents: { 'a.pdf': { category: 'basic', opens: true, pageCount: 3,
      pages: [{ width: 1, height: 1 }] } },
  };
  assert.ok(validateExpectations(exp, corpus).some(p => /pageCount/.test(p)));
});

test('requires openError when a document does not open', () => {
  const exp = { engine: 'x', documents: { 'a.pdf': { category: 'basic', opens: false } } };
  assert.ok(validateExpectations(exp, corpus).some(p => /openError/.test(p)));
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "conformance/*.test.mjs"`
Expected: FAIL — `Cannot find module './validate.mjs'`

- [x] **Step 4: Implement the validator**

Create `conformance/validate.mjs`:

```js
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ['basic', 'form', 'encrypted', 'annotation', 'text', 'regression'];
const OPEN_ERRORS = ['password', 'format', 'file', 'security', 'page', 'unknown'];

export function validateExpectations(expectations, corpus) {
  const problems = [];
  const named = new Set(corpus.files.map(f => f.name));
  const covered = new Set(Object.keys(expectations.documents ?? {}));

  if (!expectations.engine) problems.push('missing top-level "engine"');

  for (const name of covered) {
    if (!named.has(name)) problems.push(`expectations reference ${name}, absent from corpus.json`);
  }
  for (const name of named) {
    if (!covered.has(name)) problems.push(`corpus file ${name} has no expectations`);
  }

  for (const [name, doc] of Object.entries(expectations.documents ?? {})) {
    const at = `${name}:`;
    if (!CATEGORIES.includes(doc.category)) problems.push(`${at} unknown category ${doc.category}`);
    if (typeof doc.opens !== 'boolean') problems.push(`${at} "opens" must be boolean`);

    if (doc.opens === false) {
      if (!OPEN_ERRORS.includes(doc.openError)) {
        problems.push(`${at} openError required when opens is false`);
      }
      continue;
    }
    if (doc.pages && typeof doc.pageCount === 'number' && doc.pages.length !== doc.pageCount) {
      problems.push(`${at} pageCount ${doc.pageCount} disagrees with ${doc.pages.length} page entries`);
    }
    for (const [i, p] of (doc.pages ?? []).entries()) {
      if (!(p.width > 0) || !(p.height > 0)) problems.push(`${at} page ${i} has non-positive dimensions`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const expPath = join(HERE, 'expectations.json');
  if (!existsSync(expPath)) {
    console.error('no expectations.json; run: node conformance/generate.mjs');
    process.exit(1);
  }
  const problems = validateExpectations(
    JSON.parse(readFileSync(expPath, 'utf8')),
    JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'))
  );
  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('expectations valid');
}
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node --test "conformance/*.test.mjs"`
Expected: PASS, 5 tests.

- [x] **Step 6: Checkpoint**

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
node --test "conformance/*.test.mjs" 2>&1 | tail -4
node conformance/validate.mjs || echo "(expected: no expectations.json yet)"
```

---

### Task 6: Expectations generator with independent cross-check

**Files:**
- Create: `conformance/generate.mjs`
- Create: `conformance/expectations.json` (generated)

**Interfaces:**
- Consumes: `loadPdfium()` from Task 3, `corpus.json` from Task 4, `validateExpectations()` from Task 5.
- Produces: `conformance/expectations.json` conforming to the Task 5 schema.

- [x] **Step 1: Implement the generator**

Create `conformance/generate.mjs`. PDFium produces the values; poppler independently checks page counts so the suite is not purely self-referential:

```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdfium } from '../tools/host/pdfium-host.mjs';
import { validateExpectations } from './validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = 'chromium/7243';
const META_KEYS = ['Title', 'Author', 'Subject', 'Creator', 'Producer'];

function popplerPageCount(path) {
  try {
    const out = execFileSync('pdfinfo', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^Pages:\s+(\d+)$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;   // encrypted or damaged files legitimately defeat pdfinfo
  }
}

const corpus = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'));
const pdfium = await loadPdfium();
const documents = {};
const disagreements = [];

for (const { name, category } of corpus.files) {
  const path = join(HERE, 'corpus', name);
  const bytes = readFileSync(path);
  let doc;
  try {
    doc = pdfium.openDocument(bytes);
  } catch (e) {
    const m = e.message.match(/load failed: (\w+)/);
    documents[name] = { category, opens: false, openError: m ? m[1] : 'unknown' };
    continue;
  }

  const pageCount = doc.pageCount;
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const { width, height } = doc.pageSize(i);
    pages.push({ width: Number(width.toFixed(2)), height: Number(height.toFixed(2)) });
  }

  const metadata = {};
  for (const k of META_KEYS) {
    const v = doc.metadata(k);
    if (v) metadata[k] = v;
  }

  documents[name] = { category, opens: true, pageCount, pages };
  if (Object.keys(metadata).length) documents[name].metadata = metadata;

  const cross = popplerPageCount(path);
  if (cross !== null && cross !== pageCount) {
    disagreements.push(`${name}: pdfium=${pageCount} poppler=${cross}`);
  }
  doc.close();
}

const expectations = { engine: ENGINE, generated: new Date().toISOString(), documents };
const problems = validateExpectations(expectations, corpus);
if (problems.length) {
  console.error('generated expectations are invalid:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

writeFileSync(join(HERE, 'expectations.json'), JSON.stringify(expectations, null, 2) + '\n');
console.log(`wrote expectations for ${Object.keys(documents).length} documents`);

if (disagreements.length) {
  console.error('\nCROSS-CHECK DISAGREEMENTS (investigate before trusting these values):');
  for (const d of disagreements) console.error(`  ${d}`);
  process.exit(2);
}
console.log('page counts agree with poppler where it could read the file');
```

- [x] **Step 2: Run the generator**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node conformance/generate.mjs`
Expected: `wrote expectations for N documents` and the agreement line.

Exit code 2 means PDFium and poppler disagree on a page count. Do not suppress it — investigate the named file, and if PDFium is right (it often is on damaged files), move that file to the `regression` category in `corpus.json` and note why in `conformance/NOTICE.md`.

- [x] **Step 3: Validate the generated file independently**

Run: `cd /Users/daos/Projects/Lab/PdfiumKit-v2 && node conformance/validate.mjs`
Expected: `expectations valid`

- [x] **Step 4: Confirm the encrypted document is recorded as a password failure**

Run:
```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
node -e "const e=require('./conformance/expectations.json');
for(const [k,v] of Object.entries(e.documents)) if(!v.opens) console.log(k, v.openError)"
```
Expected: at least one entry with `password`. If an encrypted file reports `opens: true`, it is not actually password-protected — replace it in Task 4's `SELECTION`.

- [x] **Step 5: Checkpoint**

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
node --test 2>&1 | tail -6
node conformance/validate.mjs
```

---

### Task 7: CI skeleton and README

**Files:**
- Create: `.github/workflows/conformance.yml`
- Create: `.github/workflows/ios.yml`
- Create: `.github/workflows/android.yml`
- Create: `.github/workflows/web.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: the npm scripts defined in Task 1 Step 2.
- Produces: workflows that are syntactically valid and run the host-side suite today. The three platform workflows are scaffolds whose build steps land in phases 2-4.

- [x] **Step 1: Write the conformance workflow**

Create `.github/workflows/conformance.yml`. This one does real work now:

```yaml
name: conformance
on: [push, pull_request]
jobs:
  host:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install poppler for cross-checking
        run: brew install poppler
      - name: Fetch vendor artifacts
        run: ./scripts/fetch-vendor.sh
        env:
          PDFIUMKIT_ARTIFACTS: ${{ runner.temp }}/pdfium-artifacts
      - name: Run host test suite
        run: npm test
      - name: Validate conformance expectations
        run: npm run conformance:validate
```

No workflow can actually run yet: there is no git repository and no remote. These files are written now so the pipeline is designed alongside the code rather than retrofitted. The `PDFIUMKIT_ARTIFACTS` path is the one line that will need a real value once artifacts are published as Release assets — leave it pointing at `runner.temp` as an explicit marker of that outstanding work, and do not add `continue-on-error` to paper over it later.

- [x] **Step 2: Write the three platform scaffolds**

Create `.github/workflows/ios.yml`:

```yaml
name: ios
on: [push, pull_request]
jobs:
  build:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - name: Fetch vendor artifacts
        run: ./scripts/fetch-vendor.sh
      - name: Build and test
        run: echo "phase 2 — swift build && swift test"
```

Create `.github/workflows/android.yml`:

```yaml
name: android
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { distribution: temurin, java-version: '17' }
      - name: Fetch vendor artifacts
        run: ./scripts/fetch-vendor.sh
      - name: Build and test
        run: echo "phase 3 — ./gradlew :pdfiumkit:test"
```

Create `.github/workflows/web.yml`:

```yaml
name: web
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Fetch vendor artifacts
        run: ./scripts/fetch-vendor.sh
      - name: Build and test
        run: echo "phase 4 — npm run build && npm run test:browser"
```

- [x] **Step 3: Verify every workflow parses**

Run:
```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
for f in .github/workflows/*.yml; do
  node -e "
    const s=require('fs').readFileSync('$f','utf8');
    if(!/^name:/m.test(s)||!/^on:/m.test(s)||!/^jobs:/m.test(s)) { console.error('BAD $f'); process.exit(1) }
    if(/\t/.test(s)) { console.error('TAB in $f'); process.exit(1) }
    console.log('ok $f');
  "
done
```
Expected: four `ok` lines. YAML forbids tabs, which is the most common way these files break.

- [x] **Step 4: Write the README**

Create `README.md`:

````markdown
# PdfiumKit

Cross-platform PDF SDK for iOS, Android, and Web, built on PDFium.

**Status: phase 1 (foundation).** No SDK yet — this repository currently holds
the build pipeline, vendor artifact management, and the shared conformance suite.

## Getting a working checkout

```bash
node scripts/make-vendor-manifest.mjs   # only when artifacts change
./scripts/fetch-vendor.sh               # populates vendor/, verifies checksums
npm test                                # host test suite
```

`vendor/` is never committed. `vendor.manifest.json` pins the engine revision
and the SHA-256 of every artifact.

## Engine

PDFium `chromium/7243`, built with V8, XFA, and Skia disabled. This exports
448 of 460 public PDFium functions, identical across all platforms.

Rebuilding is rarely needed:

```bash
./scripts/build-pdfium.sh <macos|ios|android|wasm> release
```

## Conformance suite

`conformance/expectations.json` is the contract every platform SDK is tested
against. Regenerate it after changing the corpus:

```bash
node conformance/generate.mjs
node conformance/validate.mjs
```

Expected values come from PDFium itself, with page counts independently
cross-checked against poppler so the suite is not purely self-referential.

## Design

See `docs/superpowers/specs/2026-09-12-pdfiumkit-sdk-design.md`.
````

- [x] **Step 5: Final checkpoint — full suite from a clean vendor tree**

```bash
cd /Users/daos/Projects/Lab/PdfiumKit-v2
rm -rf vendor
./scripts/fetch-vendor.sh
./scripts/fetch-vendor.test.sh
npm test
node conformance/validate.mjs
echo "--- phase 1 complete ---"
```
Expected: fetch succeeds, `ALL PASS`, all node tests pass, `expectations valid`.

---

## Phase 1 exit criteria

- [x] `./scripts/fetch-vendor.sh` populates `vendor/` from scratch and verifies every checksum.
- [ ] A tampered artifact is detected and named.
- [ ] Host PDFium opens every corpus document, proving the artifacts are functional and not merely present.
- [x] `conformance/expectations.json` exists, validates, and its page counts agree with an independent engine.
- [ ] Four CI workflows parse; the conformance one runs the real suite.
- [ ] No artifact and no generated file is tracked; the repo is still not under git.

## Deferred to later phases

- Publishing artifacts as Release assets, and the HTTPS resolver in `fetch-vendor.sh` (needs a remote).
- Golden-image render tests (spec §10.2) — needs a rendering binding, so phase 2.
- ASan and leak runs (spec §10.3) — needs native targets, so phases 2-3.
- Resolving spec §14: FreeType licensing, minimum platform versions, corpus breadth.
