#!/usr/bin/env bash
# Runs the PDFium corpus through the iOS SDK in the simulator: the iOS twin of
# `node conformance/robustness.mjs`. Writes conformance/robustness-report-ios.json.
#
# A crash kills the test process, so the test records the index it started before each
# document; when a run ends early, that document is recorded as a crash and the test runs
# again from the next one.
#
# Usage: scripts/sweep-ios.sh [corpusDir]
set -euo pipefail
cd "$(dirname "$0")/.."

CORPUS="${1:-/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources}"
DESTINATION="${PDFIUMKIT_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0}"
work=$(mktemp -d)
results="$work/results.jsonl"
touch "$results"
total=$(find "$CORPUS" -name '*.pdf' | wc -l | tr -d ' ')
echo "sweeping $total documents from $CORPUS"

xcodebuild build-for-testing -scheme PdfiumKit-Package -destination "$DESTINATION" -quiet

start=0
while [ "$start" -lt "$total" ]; do
    rm -f "$results.started"
    TEST_RUNNER_SWEEP_CORPUS="$CORPUS" TEST_RUNNER_SWEEP_RESULTS="$results" TEST_RUNNER_SWEEP_START="$start" \
        xcodebuild test-without-building -scheme PdfiumKit-Package -destination "$DESTINATION" \
        -only-testing:PdfiumKitTests/CorpusSweepTests > "$work/run.log" 2>&1 || true
    # A run that never reached the test is a broken setup, not a crash in a document.
    if ! grep -q "Test Case '-\[PdfiumKitTests.CorpusSweepTests testSweep\]' started" "$work/run.log"; then
        echo "sweep: the test did not start; last lines of the run:" >&2
        tail -20 "$work/run.log" >&2
        exit 1
    fi

    started=$(cat "$results.started" 2>/dev/null || echo "$start")
    recorded=$(python3 -c 'import json,sys; print(max([json.loads(l)["index"] for l in open(sys.argv[1]) if l.strip()] or [-1]))' "$results")
    if [ "$recorded" -lt "$started" ]; then
        # The process died on this document before it could record anything.
        file=$(find "$CORPUS" -name '*.pdf' | sed "s|^$CORPUS/||" | LC_ALL=C sort | sed -n "$((started + 1))p")
        printf '{"index": %d, "file": "%s", "outcome": "crash", "code": "process died"}\n' "$started" "$file" >> "$results"
        echo "  CRASH          $file"
        start=$((started + 1))
    else
        start=$((recorded + 1))
    fi
    echo "  … $start/$total"
done

python3 - "$results" "$CORPUS" "$total" <<'PY'
import json, sys
results, corpus, total = sys.argv[1], sys.argv[2], int(sys.argv[3])
records = {}
for line in open(results):
    if line.strip():
        r = json.loads(line); records[r["index"]] = r
ordered = [records[i] for i in sorted(records)]
tally = {k: 0 for k in ["ok", "rejected", "typed-error", "untyped-throw", "crash", "timeout"]}
for r in ordered: tally[r["outcome"]] = tally.get(r["outcome"], 0) + 1
out = [{k: v for k, v in r.items() if k != "index"} for r in ordered]
json.dump({"corpus": corpus, "ran": len(ordered), "tally": tally, "results": out},
          open("conformance/robustness-report-ios.json", "w"), indent=2)
print("\n── summary ──")
for k, v in tally.items():
    if v: print(f"  {k:<14} {v}")
for r in ordered:
    if r["outcome"] in ("crash", "untyped-throw", "timeout"): print(f"  {r['outcome'].upper():<14} {r['file']}  {r.get('code', '')}")
print("\nreport: conformance/robustness-report-ios.json")
sys.exit(1 if tally["crash"] + tally["untyped-throw"] > 0 else 0)
PY
