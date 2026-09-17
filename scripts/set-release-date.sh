#!/usr/bin/env bash
# Writes the release date every license check compares a key's expiry against.
#
#   ./scripts/set-release-date.sh 2026-10-01
set -euo pipefail
cd "$(dirname "$0")/.."
date="${1:?usage: set-release-date.sh YYYY-MM-DD}"
[[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "not a YYYY-MM-DD date: $date" >&2; exit 1; }

sed -i '' -E "s/(RELEASE_DATE = ')[0-9-]+(')/\1$date\2/" web/src/license/build.ts
sed -i '' -E "s/(static let releaseDate = \")[0-9-]+(\")/\1$date\2/" ios/Sources/PDFCora/License/PdfLicense.swift
sed -i '' -E "s/(const val RELEASE_DATE = \")[0-9-]+(\")/\1$date\2/" android/pdfcora/src/main/java/com/pdfcora/license/PdfLicense.kt

written=$(grep -h "$date" web/src/license/build.ts ios/Sources/PDFCora/License/PdfLicense.swift \
    android/pdfcora/src/main/java/com/pdfcora/license/PdfLicense.kt | wc -l | tr -d ' ')
[ "$written" = 3 ] || { echo "release date was written to $written of 3 platforms" >&2; exit 1; }
echo "release date: $date"
