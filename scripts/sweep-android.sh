#!/usr/bin/env bash
# Runs the PDFium corpus through the Android SDK on a device or emulator: the Android twin
# of `node conformance/robustness.mjs`. Writes conformance/robustness-report-android.json.
#
# A crash kills the test process, so the test records the index it started before each
# document; when a run ends early, that document is recorded as a crash and the test runs
# again from the next one.
#
# Usage: ANDROID_SERIAL=<device> scripts/sweep-android.sh [corpusDir]
set -euo pipefail
cd "$(dirname "$0")/.."

CORPUS="${1:-/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources}"
ON_DEVICE=/data/local/tmp/pdfium-corpus
PACKAGE=com.pdfiumkit.test
work=$(mktemp -d)
total=$(find "$CORPUS" -name '*.pdf' | wc -l | tr -d ' ')
echo "sweeping $total documents from $CORPUS"

# Installed by hand: the test APK targets minSdk, which Android 15+ refuses without the bypass.
(cd android && gradle :pdfiumkit:assembleDebugAndroidTest --console=plain -q)
adb install -r -t --bypass-low-target-sdk-block \
    android/pdfiumkit/build/outputs/apk/androidTest/debug/pdfiumkit-debug-androidTest.apk > /dev/null
adb shell rm -rf "$ON_DEVICE"
adb push "$CORPUS" "$ON_DEVICE" > /dev/null
adb shell run-as "$PACKAGE" rm -f files/sweep.jsonl files/sweep.started

crashes="$work/crashes.jsonl"
: > "$crashes"
# exec-out puts cat's complaint on stdout, where it would pass for a result.
device_cat() { adb exec-out run-as "$PACKAGE" sh -c "cat $1 2>/dev/null" || true; }

start=0
while [ "$start" -lt "$total" ]; do
    adb shell am instrument -w -e class com.pdfiumkit.CorpusSweepTest -e sweepCorpus "$ON_DEVICE" \
        -e sweepStart "$start" "$PACKAGE/com.pdfiumkit.LicensedTestRunner" > "$work/run.log" 2>&1 || true
    device_cat files/sweep.jsonl > "$work/results.jsonl"
    started=$(device_cat files/sweep.started)
    # A run that never reached the test is a broken setup, not a crash in a document.
    [ -n "$started" ] || { echo "sweep: the test did not start; the run said:" >&2; cat "$work/run.log" >&2; exit 1; }

    recorded=$(python3 -c 'import json,sys; print(max([json.loads(l)["index"] for l in open(sys.argv[1]) if l.strip()] or [-1]))' "$work/results.jsonl")
    if [ "$recorded" -lt "$started" ]; then
        # The process died on this document before it could record anything.
        file=$(find "$CORPUS" -name '*.pdf' | sed "s|^$CORPUS/||" | LC_ALL=C sort | sed -n "$((started + 1))p")
        printf '{"index": %d, "file": "%s", "outcome": "crash", "code": "process died"}\n' "$started" "$file" >> "$crashes"
        echo "  CRASH          $file"
        start=$((started + 1))
    else
        start=$((recorded + 1))
    fi
    echo "  … $start/$total"
done

device_cat files/sweep.jsonl > "$work/results.jsonl"
cat "$crashes" >> "$work/results.jsonl"
python3 - "$work/results.jsonl" "$CORPUS" <<'PY'
import json, sys
results, corpus = sys.argv[1], sys.argv[2]
records = {}
for line in open(results):
    if line.strip():
        r = json.loads(line); records[r["index"]] = r
ordered = [records[i] for i in sorted(records)]
tally = {k: 0 for k in ["ok", "rejected", "typed-error", "untyped-throw", "crash", "timeout"]}
for r in ordered: tally[r["outcome"]] = tally.get(r["outcome"], 0) + 1
out = [{k: v for k, v in r.items() if k != "index"} for r in ordered]
json.dump({"corpus": corpus, "ran": len(ordered), "tally": tally, "results": out},
          open("conformance/robustness-report-android.json", "w"), indent=2)
print("\n── summary ──")
for k, v in tally.items():
    if v: print(f"  {k:<14} {v}")
for r in ordered:
    if r["outcome"] in ("crash", "untyped-throw", "timeout"): print(f"  {r['outcome'].upper():<14} {r['file']}  {r.get('code', '')}")
print("\nreport: conformance/robustness-report-android.json")
sys.exit(1 if tally["crash"] + tally["untyped-throw"] > 0 else 0)
PY
