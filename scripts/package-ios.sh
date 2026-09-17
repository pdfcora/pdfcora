#!/usr/bin/env bash
# Produces the distributable pdfium.xcframework zip and its SPM checksum.
#
# Package.swift uses a local binaryTarget for development. For release, the xcframework
# must be hosted, because vendor/ is not committed — a consumer resolving the package
# from git would otherwise get no binary at all.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
XCF="$ROOT/vendor/ios/pdfium.xcframework"
OUT="$ROOT/build/release"

[ -d "$XCF" ] || { echo "missing $XCF — run ./scripts/fetch-vendor.sh" >&2; exit 1; }

mkdir -p "$OUT"
ZIP="$OUT/pdfium.xcframework.zip"
rm -f "$ZIP"

( cd "$(dirname "$XCF")" && zip -qr "$ZIP" "$(basename "$XCF")" )
CHECKSUM=$(swift package compute-checksum "$ZIP")

cat > "$OUT/binary-target.swift" <<SNIPPET
// Paste into Package.swift for a release, replacing the local .binaryTarget:
.binaryTarget(
    name: "pdfium",
    url: "https://github.com/<owner>/PDFCora/releases/download/<tag>/pdfium.xcframework.zip",
    checksum: "$CHECKSUM"
),
SNIPPET

echo "zip      : $ZIP ($(du -h "$ZIP" | cut -f1))"
echo "checksum : $CHECKSUM"
echo "snippet  : $OUT/binary-target.swift"
