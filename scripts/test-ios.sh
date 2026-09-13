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

# The signing cross-check. An iOS test cannot spawn a process, so the suite writes a
# signed document here and the gate runs on the host. Our own verifier agreeing with our
# own signer would prove nothing; pdfsig is an independent implementation.
SIGNED=/tmp/pdfiumkit-ios-signed.pdf
if command -v pdfsig > /dev/null; then
    [ -f "$SIGNED" ] || { echo "cross-check: $SIGNED was not written" >&2; exit 1; }
    report=$(pdfsig "$SIGNED" 2>&1 || true)
    case "$report" in
        *"Signature is Valid"*) ;;
        *) echo "cross-check: pdfsig rejected the signature" >&2; echo "$report" >&2; exit 1 ;;
    esac
    case "$report" in
        *"Total document signed"*) ;;
        *) echo "cross-check: pdfsig says the signature does not cover the file" >&2; exit 1 ;;
    esac
    echo "cross-check:   pdfsig accepts the iOS-signed document"
else
    echo "cross-check:   skipped, pdfsig is not installed" >&2
fi
