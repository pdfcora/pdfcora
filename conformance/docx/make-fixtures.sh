#!/usr/bin/env bash
# Builds the DOCX fixtures in conformance/fixtures/docx from the XML in conformance/docx/src.
#
# hello.docx, empty.docx, not-docx.zip and truncated.docx are rebuilt every run.
# legacy.doc needs LibreOffice, and encrypted.docx needs msoffcrypto-tool
# (pip install msoffcrypto-tool); both are committed, so they are only made when missing.
set -euo pipefail
cd "$(dirname "$0")"
SRC="$(pwd)/src"
OUT="$(cd .. && pwd)/fixtures/docx"
mkdir -p "$OUT"

pack() { # pack <src-dir> <out-file>
  rm -f "$2"
  # A fixed time stamp keeps the bytes the same from run to run.
  find "$1" -exec touch -t 202601010000 {} +
  (cd "$1" && zip -X -q -r "$2" .)
}

pack "$SRC/hello" "$OUT/hello.docx"
pack "$SRC/empty" "$OUT/empty.docx"
pack "$SRC/not-docx" "$OUT/not-docx.zip"

size=$(wc -c < "$OUT/hello.docx")
head -c $((size / 2)) "$OUT/hello.docx" > "$OUT/truncated.docx"

if [ ! -f "$OUT/legacy.doc" ]; then
  tmp="$(mktemp -d)"
  soffice --headless --convert-to doc --outdir "$tmp" "$OUT/hello.docx" >/dev/null
  mv "$tmp/hello.doc" "$OUT/legacy.doc"
  rm -rf "$tmp"
fi

if [ ! -f "$OUT/encrypted.docx" ]; then
  echo "making encrypted.docx: msoffcrypto-tool -e -p secret hello.docx encrypted.docx"
  msoffcrypto-tool -e -p secret "$OUT/hello.docx" "$OUT/encrypted.docx"
fi

ls -la "$OUT"
