#!/usr/bin/env bash
# Builds the JNI shared library the Java SDK loads, one per platform, from the static
# PDFium engine in vendor/desktop.
#
#   ./scripts/build-jni.sh [macos|linux|all]
#
# macOS builds on this host; Linux builds in the same container as the engine, because
# the objects need Chromium's lld and sysroot. Output goes to the resources the Gradle
# build packages:  java/src/main/resources/native/<platform>/
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
TARGET="${1:-all}"
GLUE="$ROOT/java/src/main/cpp/pdfiumkit_jni.cpp"
HEADERS="$ROOT/vendor/desktop/include/public"
OUT="$ROOT/java/src/main/resources/native"

[ -d "$HEADERS" ] || { echo "no engine headers in $HEADERS; run ./scripts/fetch-vendor.sh" >&2; exit 1; }

jni_includes() {
  local home="${JAVA_HOME:-$(/usr/libexec/java_home 2>/dev/null || true)}"
  [ -n "$home" ] || { echo "set JAVA_HOME to a JDK 17 or newer" >&2; exit 1; }
  echo "-I$home/include -I$home/include/darwin -I$home/include/linux"
}

build_macos() {
  local lib="$ROOT/vendor/desktop/macos/libpdfium.a"
  [ -f "$lib" ] || { echo "no macOS engine; run ./scripts/build-pdfium.sh macos release in the engine checkout" >&2; return 1; }
  # This PDFium predates the macOS 26 SDK; the engine build picks an older Xcode and so
  # must this, or the glue links against headers the engine was not built for.
  if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode_16_4.app ]; then
    export DEVELOPER_DIR=/Applications/Xcode_16_4.app/Contents/Developer
  fi
  local sdk; sdk="$(xcrun --sdk macosx --show-sdk-path)"
  for arch in arm64 x86_64; do
    local dest="$OUT/macos-$arch"
    mkdir -p "$dest"
    echo "==> macOS $arch"
    xcrun clang++ -std=c++17 -O2 -fPIC -dynamiclib \
      -isysroot "$sdk" -arch "$arch" \
      $(jni_includes) -I"$HEADERS" \
      "$GLUE" "$lib" \
      -framework CoreGraphics -framework CoreFoundation -lc++ \
      -o "$dest/libpdfiumkit_jni.dylib"
  done
}

build_linux() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
    echo "the Linux JNI library builds in a container; start Docker" >&2; return 1; }
  local engine="${PDFIUMKIT_ARTIFACTS:-/Users/daos/Projects/Lab/pdfiumkit}"
  [ -d "$engine/src-linux/pdfium" ] || {
    echo "no Linux engine checkout at $engine/src-linux; run ./build-pdfium.sh linux release there" >&2; return 1; }
  mkdir -p "$OUT/linux-x86_64" "$OUT/linux-aarch64"

  # The engine image has no JDK, and the glue needs jni.h. One layer on top of it.
  if ! docker image inspect pdfium-jni >/dev/null 2>&1; then
    echo "==> Building the pdfium-jni image (engine image plus a JDK)"
    tmp="$(mktemp -d)"
    printf 'FROM pdfium-linux\nARG DEBIAN_FRONTEND=noninteractive\nRUN apt-get -y update && apt-get install -y openjdk-17-jdk-headless --no-install-recommends && rm -rf /var/lib/apt/lists/*\n' > "$tmp/Dockerfile"
    docker build --platform linux/amd64 -t pdfium-jni "$tmp"
    rm -rf "$tmp"
  fi

  docker run --platform linux/amd64 --rm \
    -v "$ROOT":/sdk -v "$engine":/engine -w /engine/src-linux/pdfium pdfium-jni bash -c '
      set -euo pipefail
      B=third_party/llvm-build/Release+Asserts/bin
      JAVA_HOME=$(dirname $(dirname $(readlink -f $(which javac))))
      JNI="-I$JAVA_HOME/include -I$JAVA_HOME/include/linux"
      for pair in "x86_64 x86_64-unknown-linux-gnu debian_bullseye_amd64-sysroot linux-x86_64" \
                  "aarch64 aarch64-unknown-linux-gnu debian_bullseye_arm64-sysroot linux-aarch64"; do
        set -- $pair
        echo "==> Linux $1"
        # lld, not GNU ld: the engine objects carry CREL relocations.
        $B/clang++ -std=c++17 -O2 -fPIC -shared --target="$2" \
          --sysroot="build/linux/$3" -fuse-ld=lld -B "$B" \
          $JNI -I/sdk/vendor/desktop/include/public \
          /sdk/java/src/main/cpp/pdfiumkit_jni.cpp \
          "/sdk/vendor/desktop/$( [ "$1" = x86_64 ] && echo linux-x64 || echo linux-arm64 )/libpdfium.a" \
          -lpthread -ldl -lm \
          -o "/sdk/java/src/main/resources/native/$4/libpdfiumkit_jni.so"
      done'
}

case "$TARGET" in
  macos) build_macos ;;
  linux) build_linux ;;
  all)   build_macos; build_linux || echo "note: Linux library not built" >&2 ;;
  *) echo "usage: $0 [macos|linux|all]" >&2; exit 1 ;;
esac

echo "JNI libraries:"
find "$OUT" -name 'libpdfiumkit_jni.*' -exec ls -la {} \;
