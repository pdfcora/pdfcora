#!/usr/bin/env bash
# The core must not depend on any AI runtime. pdfcora-ai may; pdfcora may not.
#
# The check is on the *resolved* graph, not the declared one: a transitive pull-in is
# exactly the failure this exists to catch.
set -uo pipefail
cd "$(dirname "$0")/.."

BANNED='mlkit|ml-kit|play-services|aicore|genai|FoundationModels'
fail=0

# Swift: the core has no external dependencies at all, so anything is a regression.
deps=$(swift package show-dependencies --format flatlist 2>/dev/null | grep . || true)
if [ -n "$deps" ]; then
  echo "core Swift package gained a dependency:"
  echo "$deps"
  fail=1
fi

# Web: runtime dependencies only. Dev tooling is not shipped.
web=$(node -p 'JSON.stringify(require("./web/package.json").dependencies||{})')
if [ "$web" != "{}" ]; then
  echo "core web package gained a runtime dependency: $web"
  fail=1
fi

# Android: the resolved runtime classpath.
android=$( (cd android && gradle -q :pdfcora:dependencies \
             --configuration releaseRuntimeClasspath --console=plain 2>/dev/null) \
           | grep -Ei "$BANNED" || true)
if [ -n "$android" ]; then
  echo "core Android module resolves an AI runtime:"
  echo "$android"
  fail=1
fi

# PKG-1: the AI packages ship alongside the core with matching versions. Drift is how an
# integrator ends up pairing incompatible halves.
core_web=$(node -p 'require("./web/package.json").version')
ai_web=$(node -p 'require("./web-ai/package.json").version')
if [ "$core_web" != "$ai_web" ]; then
  echo "version drift: @pdfcora/web $core_web vs @pdfcora/web-ai $ai_web"
  fail=1
fi

core_android=$(grep -m1 '^version = ' android/pdfcora/build.gradle.kts | cut -d'"' -f2)
ai_android=$(grep -m1 '^version = ' android/pdfcora-ai/build.gradle.kts | cut -d'"' -f2)
if [ "$core_android" != "$ai_android" ]; then
  echo "version drift: pdfcora $core_android vs pdfcora-ai $ai_android"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "core dependency graph is clean, versions aligned"
exit "$fail"
