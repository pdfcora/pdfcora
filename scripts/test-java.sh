#!/usr/bin/env bash
# Runs the Java SDK's tests against the shared conformance fixtures.
#
# The JNI library for this platform must exist; scripts/build-jni.sh makes it from the
# engine in vendor/, which scripts/fetch-vendor.sh puts there.
set -euo pipefail
cd "$(dirname "$0")/.."

case "$(uname -s)" in
  Darwin) arch="$(uname -m)"; [ "$arch" = arm64 ] && platform=macos-arm64 || platform=macos-x86_64
          library="libpdfcora_jni.dylib" ;;
  Linux)  arch="$(uname -m)"; [ "$arch" = aarch64 ] && platform=linux-aarch64 || platform=linux-x86_64
          library="libpdfcora_jni.so" ;;
  *) echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
esac

if [ ! -f "java/src/main/resources/native/$platform/$library" ]; then
  echo "no JNI engine for $platform; run ./scripts/build-jni.sh" >&2
  exit 1
fi

cd java
gradle test "$@"
cd ..

# The same judge the other platforms answer to: the suite writes a tagged document and
# veraPDF says whether its PDF/UA-1 claim is true.
if [ -f build/remediation/written-java.pdf ]; then
  ./scripts/verapdf-ua1.sh build/remediation/written-java.pdf
fi

# Likewise for signing: poppler's pdfsig shares no code with this SDK, so it is the one
# that can say the signature is sound rather than merely self-consistent.
if [ -f build/sign/signed-java.pdf ] && command -v pdfsig >/dev/null; then
  report="$(pdfsig build/sign/signed-java.pdf 2>/dev/null)"
  if grep -q "Signature is Valid" <<<"$report" && grep -q "Total document signed" <<<"$report"; then
    echo "pdfsig:     build/sign/signed-java.pdf verifies"
  else
    echo "$report" >&2
    echo "pdfsig rejected the signed document" >&2
    exit 1
  fi
fi
