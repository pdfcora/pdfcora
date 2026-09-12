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
