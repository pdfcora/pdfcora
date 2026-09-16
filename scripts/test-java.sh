#!/usr/bin/env bash
# Runs the Java SDK's tests against the shared conformance fixtures.
#
# The JNI library for this platform must exist; scripts/build-jni.sh makes it from the
# engine in vendor/, which scripts/fetch-vendor.sh puts there.
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(uname -s)" in
  Darwin) arch="$(uname -m)"; [ "$arch" = arm64 ] && platform=macos-arm64 || platform=macos-x86_64
          library="libpdfiumkit_jni.dylib" ;;
  Linux)  arch="$(uname -m)"; [ "$arch" = aarch64 ] && platform=linux-aarch64 || platform=linux-x86_64
          library="libpdfiumkit_jni.so" ;;
  *) echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
esac

if [ ! -f "java/src/main/resources/native/$platform/$library" ]; then
  echo "no JNI engine for $platform; run ./scripts/build-jni.sh" >&2
  exit 1
fi

cd java
gradle test "$@"
