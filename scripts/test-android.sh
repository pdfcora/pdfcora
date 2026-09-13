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
