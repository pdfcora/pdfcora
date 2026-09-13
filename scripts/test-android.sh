#!/usr/bin/env bash
# Runs the Android instrumented tests against a connected device or emulator.
#
# Two passes, because they cannot share a process: BlastRadiusTest leaves native render
# threads spinning forever, and PDFium's global state does not survive that.
set -euo pipefail
cd "$(dirname "$0")/../android"

gradle :pdfiumkit:connectedDebugAndroidTest --console=plain "$@"

gradle :pdfiumkit:connectedDebugAndroidTest --console=plain \
  -Pandroid.testInstrumentationRunnerArguments.annotation=com.pdfiumkit.LeaksNativeThreads \
  -Pandroid.testInstrumentationRunnerArguments.notAnnotation= "$@"

# The AI module's unit tests. No device needed — nothing in Phase 0 touches the engine.
gradle :pdfiumkit-ai:testDebugUnitTest --console=plain "$@"

# The signing cross-check. An instrumented test cannot run pdfsig — the device has no
# poppler — so the suite writes a signed document and the gate runs here. Our own
# verifier agreeing with our own signer would prove nothing.
SIGNED=/tmp/pdfiumkit-android-signed.pdf
if command -v pdfsig > /dev/null; then
    device=$(adb devices | awk '/device$/{print $1; exit}')
    [ -n "$device" ] || { echo "cross-check: no device" >&2; exit 1; }

    adb -s "$device" exec-out run-as com.pdfiumkit.test \
        cat files/pdfiumkit-android-signed.pdf > "$SIGNED" 2>/dev/null
    [ -s "$SIGNED" ] || { echo "cross-check: could not pull the signed document" >&2; exit 1; }

    report=$(pdfsig "$SIGNED" 2>&1 || true)
    case "$report" in
        *"Signature is Valid"*) ;;
        *) echo "cross-check: pdfsig rejected the signature" >&2; echo "$report" >&2; exit 1 ;;
    esac
    case "$report" in
        *"Total document signed"*) ;;
        *) echo "cross-check: pdfsig says the signature does not cover the file" >&2; exit 1 ;;
    esac
    echo "cross-check:   pdfsig accepts the Android-signed document"
else
    echo "cross-check:   skipped, pdfsig is not installed" >&2
fi
