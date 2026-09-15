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
    # AGP 8.7 uninstalls the test APK after a run, which deletes the files the cross-checks
    # below pull from it.
    if gradle "$@" -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true --console=plain 2>&1 | tee "$log"; then
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
run :pdfiumkit-ui:connectedDebugAndroidTest "$@"

run :pdfiumkit:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.annotation=com.pdfiumkit.LeaksNativeThreads \
  -Pandroid.testInstrumentationRunnerArguments.notAnnotation= "$@"

# The AI module: its pure logic on the JVM, and answers against the shared contract
# document on the device, since those need the engine.
run :pdfiumkit-ai:testDebugUnitTest "$@"
run :pdfiumkit-ai:connectedDebugAndroidTest "$@"

# The signing cross-check. An instrumented test cannot run pdfsig — the device has no
# poppler — so the suite writes a signed document and the gate runs here. Our own
# verifier agreeing with our own signer would prove nothing.
# Checks a pulled document with pdfsig: the signature is valid and covers the whole file.
check_pdfsig() {
    local file="$1" label="$2" report
    report=$(pdfsig "$file" 2>&1 || true)
    case "$report" in
        *"Signature is Valid"*) ;;
        *) echo "cross-check: pdfsig rejected the $label signature" >&2; echo "$report" >&2; exit 1 ;;
    esac
    case "$report" in
        *"Total document signed"*) ;;
        *) echo "cross-check: pdfsig says the $label signature does not cover the file" >&2; exit 1 ;;
    esac
    echo "cross-check:   pdfsig accepts the $label document"
}

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

    # The second file is signed without a signing license, so it is watermarked first.
    for name in signed trial-signed; do
        file="/tmp/pdfiumkit-android-$name.pdf"
        adb -s "$device" exec-out run-as com.pdfiumkit.test \
            cat "files/pdfiumkit-android-$name.pdf" > "$file" 2>/dev/null
        [ -s "$file" ] || { echo "cross-check: could not pull $file" >&2; exit 1; }
        check_pdfsig "$file" "Android-$name"
    done
else
    echo "cross-check:   skipped, pdfsig is not installed" >&2
fi

# The alt text and remediation tests write documents meant to pass PDF/UA-1; veraPDF is
# the independent judge of whether it passes PDF/UA-1.
if [ -x "${VERAPDF:-$HOME/.cache/verapdf/app/verapdf}" ] || command -v verapdf > /dev/null; then
    device="${ANDROID_SERIAL:-$(adb devices | awk '/device$/{print $1; exit}')}"
    for name in alt-text remediation; do
        adb -s "$device" exec-out run-as com.pdfiumkit.test cat "files/pdfiumkit-android-$name.pdf" \
            > "/tmp/pdfiumkit-android-$name.pdf" 2>/dev/null
    done
    ../scripts/verapdf-ua1.sh /tmp/pdfiumkit-android-alt-text.pdf /tmp/pdfiumkit-android-remediation.pdf
else
    echo "PDF/UA-1:   skipped, veraPDF is not installed (scripts/install-verapdf.sh)" >&2
fi
