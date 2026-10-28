#!/usr/bin/env bash
# Validates PDFs against PDF/UA-1 with veraPDF and fails on any failed rule.
#
# Usage: scripts/verapdf-ua1.sh [--allow CLAUSE]... file.pdf...
#
# --allow names a clause whose failures do not fail the run, for output that cannot be
# compliant by design. Every other clause still fails the run.
#
# veraPDF is found on PATH, then at $VERAPDF, then where scripts/install-verapdf.sh puts it.
set -euo pipefail

allowed=()
while [ "${1:-}" = "--allow" ]; do
    allowed+=("$2")
    shift 2
done

verapdf="${VERAPDF:-}"
[ -n "$verapdf" ] || verapdf="$(command -v verapdf || true)"
[ -n "$verapdf" ] || verapdf="$HOME/.cache/verapdf/app/verapdf"
[ -x "$verapdf" ] || { echo "PDF/UA-1: veraPDF not found; run scripts/install-verapdf.sh" >&2; exit 1; }

status=0
for file in "$@"; do
    [ -s "$file" ] || { echo "PDF/UA-1: $file is missing" >&2; status=1; continue; }
    report=$("$verapdf" --flavour ua1 --format mrr "$file" 2>/dev/null || true)
    failures=$(grep -o '<rule [^>]*status="failed"[^>]*>' <<<"$report" || true)
    for clause in ${allowed+"${allowed[@]}"}; do
        failures=$(grep -v "clause=\"$clause\"" <<<"$failures" || true)
    done

    if grep -q 'isCompliant="true"' <<<"$report"; then
        echo "PDF/UA-1:   $file passes"
    elif [ ${#allowed[@]} -gt 0 ] && [ -z "$failures" ]; then
        echo "PDF/UA-1:   $file fails only on ${allowed[*]}, which is allowed here"
    else
        echo "PDF/UA-1: $file fails" >&2
        echo "${failures:-$(tail -5 <<<"$report")}" >&2
        status=1
    fi
done
exit $status
