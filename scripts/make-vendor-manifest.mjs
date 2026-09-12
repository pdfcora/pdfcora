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
