#!/usr/bin/env bash
# Runs the iOS SDK tests on a simulator.
#
# Two passes, because they cannot share a process: BlastRadiusTests and HangProbeTests
# leave native render threads spinning forever, and PDFium's global state does not
# survive that — form-fill drawing in particular stops producing output afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

DESTINATION="${PDFIUMKIT_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0}"
LEAKY=(PdfiumKitTests/BlastRadiusTests PdfiumKitTests/HangProbeTests)

skip=()
for suite in "${LEAKY[@]}"; do skip+=("-skip-testing:$suite"); done
xcodebuild test -scheme PdfiumKit -destination "$DESTINATION" "${skip[@]}" "$@"

only=()
for suite in "${LEAKY[@]}"; do only+=("-only-testing:$suite"); done
xcodebuild test -scheme PdfiumKit -destination "$DESTINATION" "${only[@]}" "$@"
