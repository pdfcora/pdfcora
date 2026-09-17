#!/usr/bin/env bash
# Runs the Node SDK's tests. The web package is built first, because @pdfcora/node is
# a thin layer over it and a stale dist would test the wrong code.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd web && npm install --silent && npm run build --silent)
cd node
npm install --silent
npm test
