#!/usr/bin/env bash
# Validates PDFs against PDF/UA-1 with veraPDF and fails on any failed rule.
#
# Usage: scripts/verapdf-ua1.sh file.pdf...
# veraPDF is found on PATH, then at $VERAPDF, then where scripts/install-verapdf.sh puts it.
set -euo pipefail

verapdf="${VERAPDF:-}"
[ -n "$verapdf" ] || verapdf="$(command -v verapdf || true)"
[ -n "$verapdf" ] || verapdf="$HOME/.cache/verapdf/app/verapdf"
[ -x "$verapdf" ] || { echo "PDF/UA-1: veraPDF not found; run scripts/install-verapdf.sh" >&2; exit 1; }

status=0
for file in "$@"; do
    [ -s "$file" ] || { echo "PDF/UA-1: $file is missing" >&2; status=1; continue; }
    report=$("$verapdf" --flavour ua1 --format mrr "$file" 2>/dev/null || true)
    if grep -q 'isCompliant="true"' <<<"$report"; then
        echo "PDF/UA-1:   $file passes"
    else
        echo "PDF/UA-1: $file fails" >&2
        grep -o '<rule [^>]*status="failed"[^>]*>' <<<"$report" >&2 || echo "$report" | tail -5 >&2
        status=1
    fi
done
exit $status
