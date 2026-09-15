#!/usr/bin/env bash
# Runs the iOS SDK tests on a simulator.
#
# Two passes: BlastRadiusTests leaves a native render thread spinning forever, so it runs
# in its own process after everything else.
set -euo pipefail
cd "$(dirname "$0")/.."

DESTINATION="${PDFIUMKIT_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0}"
LEAKY=(PdfiumKitTests/BlastRadiusTests PdfiumKitTests/HangProbeTests)

# The package scheme, not the product scheme: once the package gained a second library
# product, the per-product schemes stopped carrying a test action at all.
SCHEME=PdfiumKit-Package

skip=(-only-testing:PdfiumKitTests)
for suite in "${LEAKY[@]}"; do skip+=("-skip-testing:$suite"); done

xcodebuild test -scheme "$SCHEME" -destination "$DESTINATION" "${skip[@]}" "$@"

# BlastRadiusTests wedges a render for real and leaves the engine unresponsive for the
# rest of the process, so it gets a process of its own. HangProbeTests stays skipped:
# it was a one-off probe, and its question is answered.
xcodebuild test -scheme "$SCHEME" -destination "$DESTINATION" \
    -only-testing:PdfiumKitTests/BlastRadiusTests "$@"

# The UI layer, end to end in the demo app: every screen renders, the component's toolbar
# can be scrolled to every item, and the component says why it cannot show a document.
# The Xcode project is generated, so it is regenerated first.
(cd ios/Demo && xcodegen generate > /dev/null)
xcodebuild test -project ios/Demo/PdfiumKitDemo.xcodeproj -scheme PdfiumKitDemo \
    -destination "$DESTINATION" "$@"

# The AI package's own suite.
xcodebuild test -scheme "$SCHEME" -destination "$DESTINATION" \
    -only-testing:PdfiumKitAITests "$@"

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
