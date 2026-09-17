#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/vendor.manifest.json"
VENDOR="$ROOT/vendor"
SOURCE="${PDFCORA_ARTIFACTS:-/Users/daos/Projects/Lab/pdfiumkit}"
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

# Desktop and server engines. Optional, because only a checkout that ran
# `build-pdfium.sh macos|linux` has them, and no mobile or web build needs them.
DESKTOP_MAP=$(cat <<'EOF'
desktop/macos/libpdfium.a|out/macos/release/lib/libpdfium.a
desktop/linux-x64/libpdfium.a|out/linux/release/x64/libpdfium.a
desktop/linux-arm64/libpdfium.a|out/linux/release/arm64/libpdfium.a
EOF
)

expected_hash() {
  node -e "const m=require('$MANIFEST');const a=m.artifacts['$1'];if(!a){console.error('not in manifest: $1');process.exit(1)}console.log(a.sha256)"
}

in_manifest() {
  node -e "const m=require('$MANIFEST');process.exit(m.artifacts['$1']?0:1)"
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

while IFS='|' read -r to from; do
  [ -z "$to" ] && continue
  dest="$VENDOR/$to"
  if ! in_manifest "$to"; then
    [ -f "$SOURCE/$from" ] && echo "note: $to was built but is not in the manifest; re-run make-vendor-manifest.mjs to include it" >&2
    continue
  fi
  if [ "$VERIFY_ONLY" = "0" ]; then
    src="$SOURCE/$from"
    # A source that has not built the desktop engines is the normal case — CI fetches a
    # release archive of the mobile and web artifacts — so this is a note, not a failure.
    if [ ! -f "$src" ]; then
      [ -f "$dest" ] || echo "note: $to is in the manifest but not in $SOURCE; skipping" >&2
      continue
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  fi
  [ -f "$dest" ] || continue
  want=$(expected_hash "$to") || { status=1; continue; }
  got=$(shasum -a 256 "$dest" | cut -d' ' -f1)
  if [ "$want" != "$got" ]; then
    echo "checksum mismatch: $to" >&2
    status=1
  fi
done <<< "$DESKTOP_MAP"

# The Emscripten glue is CommonJS, but this project declares "type": "module",
# which would make Node parse it as ESM and export nothing. Scope it back.
if [ "$VERIFY_ONLY" = "0" ] && [ -d "$VENDOR/web" ]; then
  echo '{ "type": "commonjs" }' > "$VENDOR/web/package.json"
fi

# Each xcframework slice must carry the Headers dir its Info.plist declares,
# or Xcode rejects the whole framework.
if [ "$VERIFY_ONLY" = "0" ]; then
  for slice in ios-arm64 ios-arm64_x86_64-simulator; do
    slice_src="$SOURCE/out/ios/release/pdfium.xcframework/$slice/Headers"
    if [ -d "$slice_src" ]; then
      rm -rf "$VENDOR/ios/pdfium.xcframework/$slice/Headers"
      cp -R "$slice_src" "$VENDOR/ios/pdfium.xcframework/$slice/Headers"
    else
      echo "missing xcframework headers: $slice" >&2; status=1
    fi
  done
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

# The desktop engines need headers too, from whichever desktop target was built.
# Optional, like the libraries themselves.
if [ "$VERIFY_ONLY" = "0" ] && [ -d "$VENDOR/desktop" ]; then
  for candidate in "$SOURCE/out/macos/release/include/public" "$SOURCE/out/linux/release/include/public"; do
    if [ -d "$candidate" ]; then
      mkdir -p "$VENDOR/desktop/include"
      rm -rf "$VENDOR/desktop/include/public"
      cp -R "$candidate" "$VENDOR/desktop/include/public"
      break
    fi
  done
  [ -d "$VENDOR/desktop/include/public" ] || echo "note: desktop engines have no headers; a JNI build needs them" >&2
fi

if [ "$status" = "0" ]; then
  echo "vendor/ populated and verified against $(basename "$MANIFEST")"
else
  echo "vendor fetch FAILED" >&2
fi
exit $status
