#!/usr/bin/env bash
# Runs the Android instrumented tests against a connected device or emulator.
#
# Two passes, because they cannot share a process: BlastRadiusTest leaves native render
# threads spinning forever, and PDFium's global state does not survive that.
set -euo pipefail
cd "$(dirname "$0")/../android"

# Give the emulator at least 4GB. At 2GB the suite reliably dies part-way through — the
# low-memory killer takes the test process, and whichever test was in flight is reported
# as failed with no message. Measured: identical code and tests pass 118/118 at 4GB and
# die around test 19 at 2GB.
#
#   emulator -avd <name> -memory 4096

# A run that dies to the low-memory killer reports whichever test was in flight as
# having failed, with no message. That reads as a flaky test and sends people off
# debugging code that is fine. `run` names the real cause instead.
run() {
    local log
    log=$(mktemp)
    if gradle "$@" --console=plain 2>&1 | tee "$log"; then
        rm -f "$log"
        return 0
    fi

    if grep -q "Process crashed" "$log"; then
        echo >&2
        echo "The instrumentation process died — the test named above was merely the one" >&2
        echo "running at the time, and its failure is an artefact. Cause:" >&2
        if adb logcat -b all -d 2>/dev/null | grep -m3 "lowmemorykiller.*com.pdfiumkit"; then
            echo >&2
            echo "The device ran out of memory. Give the emulator more RAM, or close things" >&2
            echo "on the host — an emulator swapping against a loaded host triggers this." >&2
        else
            echo "  no lowmemorykiller entry; check for a native crash:" >&2
            echo "  adb logcat -b crash -d   and   adb shell ls -lt /data/tombstones" >&2
        fi
    fi
    rm -f "$log"
    return 1
}

# The view model is pure logic and runs on the JVM — no device, and not hostage to an
# emulator that this project has watched die twice.
run :pdfiumkit:testDebugUnitTest "$@"

run :pdfiumkit:connectedDebugAndroidTest "$@"

run :pdfiumkit:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.annotation=com.pdfiumkit.LeaksNativeThreads \
  -Pandroid.testInstrumentationRunnerArguments.notAnnotation= "$@"

# The AI module's unit tests. No device needed — nothing in Phase 0 touches the engine.
run :pdfiumkit-ai:testDebugUnitTest "$@"

# The signing cross-check. An instrumented test cannot run pdfsig — the device has no
# poppler — so the suite writes a signed document and the gate runs here. Our own
# verifier agreeing with our own signer would prove nothing.
SIGNED=/tmp/pdfiumkit-android-signed.pdf
if command -v pdfsig > /dev/null; then
    # Gradle honours ANDROID_SERIAL, so this must too. Taking "the first device" while
    # Gradle ran on a different one pulls a stale or missing file and then blames the
    # signature for it — which is exactly what happened with a phone and an emulator
    # both plugged in.
    device="${ANDROID_SERIAL:-}"
    if [ -z "$device" ]; then
        count=$(adb devices | grep -c 'device$' || true)
        if [ "$count" -gt 1 ]; then
            echo "cross-check: $count devices connected and ANDROID_SERIAL is unset." >&2
            echo "  Gradle and this check could pick different ones. Set ANDROID_SERIAL." >&2
            exit 1
        fi
        device=$(adb devices | awk '/device$/{print $1; exit}')
    fi
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
