#!/usr/bin/env bash
set -euo pipefail

# Standalone PDFium builder (macOS, Linux, iOS, Android, WASM)
# Usage:
#   ./build-pdfium.sh <platform> [release|debug]
# Platforms: macos | linux | ios | android | wasm
#
# Prereqs:
# - git, curl, unzip
# - macOS/iOS: Xcode + CLT (xcodebuild, lipo)
# - Linux: Docker (the build runs in a container, on any host)
# - Android: toolchains are fetched via gclient; no manual NDK needed
#
# This file is the source of truth; it is copied to the engine build checkout, which is
# a separate, unversioned working directory, and run from there (ROOT is its cwd, so
# docker/ must sit beside it).
#
# Notes:
# - Builds static libs (libpdfium.a). For iOS, also produces an xcframework.
# - No Python and no code from this repository is used by the non-wasm parts.
# - For WASM we delegate to https://github.com/paulocoutinhox/pdfium-lib via Docker.

PLATFORM="${1:-macos}"
CONFIG="${2:-release}" # release|debug
PDFIUM_BRANCH="${PDFIUM_BRANCH:-chromium/7243}"
EMSDK_VERSION="${EMSDK_VERSION:-4.0.10}"

ROOT="$(pwd)"
SRC_DIR="$ROOT/src"
PDFIUM_DIR="$SRC_DIR/pdfium"
DEPOT_DIR="$ROOT/depot_tools"
OUT_DIR="$ROOT/out"
mkdir -p "$OUT_DIR"

is_debug=false
if [ "$CONFIG" = "debug" ]; then is_debug=true; fi

os_name="$(uname -s)"
sed_inplace() {
  # usage: sed_inplace 's/old/new/' file
  if [ "$os_name" = "Darwin" ]; then
    sed -i '' -e "$1" "$2"
  else
    sed -i -e "$1" "$2"
  fi
}

# Ensure sandbox-safe writable locations for caches when needed (Android path).
setup_android_sandbox_env() {
  # Some environments (like CI/sandboxes) disallow writes to the real $HOME caches
  # that vpython/CIPD use. Redirect to workspace-local paths.
  : "${ROOT:?ROOT must be set}"
  export HOME="${HOME_OVERRIDE:-$ROOT/.home}"
  mkdir -p "$HOME" "$HOME/Library/Caches" "$HOME/.cache"
  export XDG_CACHE_HOME="$HOME/.cache"
  # Optional: speed up git fetches if re-running
  export GIT_CACHE_PATH="$ROOT/.git_cache"
  mkdir -p "$GIT_CACHE_PATH"
}

ensure_depot_tools() {
  if [ ! -d "$DEPOT_DIR" ]; then
    echo "==> Cloning depot_tools..."
    git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_DIR"
  fi
  export PATH="$DEPOT_DIR:$PATH"
  export DEPOT_TOOLS_UPDATE=0
  export DEPOT_TOOLS_WIN_TOOLCHAIN=0

  # Bootstrap depot_tools so gn/ninja/python shim is ready
  if [ -x "$DEPOT_DIR/ensure_bootstrap" ]; then
    "$DEPOT_DIR/ensure_bootstrap" || true
  else
    (cd "$DEPOT_DIR" && ./update_depot_tools || true)
  fi
}

set_target_os() {
  # Accepts a comma-separated list: 'mac' or 'ios' or 'android'
  local tos="$1"
  if [ -f "$SRC_DIR/.gclient" ]; then
    if grep -q "^target_os = \[" "$SRC_DIR/.gclient"; then
      sed_inplace "s/^target_os = \[.*\]/target_os = [ $tos ]/" "$SRC_DIR/.gclient"
    else
      echo "target_os = [ $tos ]" >> "$SRC_DIR/.gclient"
    fi
  else
    mkdir -p "$SRC_DIR"
    echo "target_os = [ $tos ]" > "$SRC_DIR/.gclient.append"
  fi
}

gclient_config_sync() {
  local tos_list="$1" # e.g., 'mac' or 'ios' or 'android' or 'mac','ios','android'
  mkdir -p "$SRC_DIR"
  cd "$SRC_DIR"

  if [ ! -d "$PDFIUM_DIR" ]; then
    echo "==> gclient config pdfium (minimal)..."
    gclient config --unmanaged https://pdfium.googlesource.com/pdfium.git \
      --custom-var checkout_configuration=minimal
  fi

  set_target_os "$tos_list"
  # If we created an append file before .gclient existed, append now
  if [ -f "$SRC_DIR/.gclient.append" ]; then
    cat "$SRC_DIR/.gclient.append" >> "$SRC_DIR/.gclient"
    rm -f "$SRC_DIR/.gclient.append"
  fi

  # Reset any local changes from previous runs to allow re-sync
  if [ -d "$PDFIUM_DIR/.git" ]; then
    (cd "$PDFIUM_DIR" && git reset --hard && git clean -df) || true
    for sub in build third_party/libjpeg_turbo base/allocator/partition_allocator; do
      if [ -d "$PDFIUM_DIR/$sub/.git" ]; then
        (cd "$PDFIUM_DIR/$sub" && git reset --hard && git clean -df) || true
      fi
    done
  fi

  echo "==> gclient sync @ $PDFIUM_BRANCH..."
  # Without this the script reported success after a failed sync, and the missing
  # artifacts were only noticed later.
  gclient sync -r "origin/$PDFIUM_BRANCH" --no-history --shallow || {
    echo "gclient sync failed. A partially-deleted checkout is the usual cause: rm -rf $PDFIUM_DIR and retry." >&2
    exit 1
  }
}

base_args() {
  local target_os="$1"
  local target_cpu="$2"
  cat <<EOF
is_debug=$is_debug
treat_warnings_as_errors=false
is_component_build=false
pdf_use_partition_alloc=false
pdf_enable_v8=false
pdf_enable_xfa=false
target_os="$target_os"
target_cpu="$target_cpu"
EOF
}

build_macos() {
  echo "==> Building for macOS ($CONFIG)"

  # This PDFium revision predates the macOS 27 SDK, which drops the fortify wrappers
  # (__strcat_chk and friends) and ships a libc++ whose <complex> this clang cannot
  # parse. Build against an older Xcode when one is installed; otherwise the failure
  # is a wall of errors inside SDK headers that says nothing about the real cause.
  if [ -z "${DEVELOPER_DIR:-}" ]; then
    for candidate in /Applications/Xcode_16_4.app /Applications/Xcode_16.app; do
      if [ -d "$candidate/Contents/Developer" ]; then
        export DEVELOPER_DIR="$candidate/Contents/Developer"
        echo "==> Using $DEVELOPER_DIR (SDK $(xcrun --sdk macosx --show-sdk-version 2>/dev/null))"
        break
      fi
    done
  fi
  case "$(xcrun --sdk macosx --show-sdk-version 2>/dev/null)" in
    1[0-5].*) : ;;
    *) echo "WARNING: building against SDK $(xcrun --sdk macosx --show-sdk-version 2>/dev/null); pdfium $PDFIUM_BRANCH wants 15.x or older. Set DEVELOPER_DIR to an older Xcode if this fails." >&2 ;;
  esac

  cd "$PDFIUM_DIR"

  for cpu in x64 arm64; do
    local_out="$OUT_DIR/macos-$cpu-$CONFIG"
    mkdir -p "$local_out"
    args="$(base_args mac "$cpu")
pdf_is_standalone=true
use_custom_libcxx=false
use_sysroot=false
use_allocator_shim=false
pdf_is_complete_lib=true
$( [ "$CONFIG" = "release" ] && echo "symbol_level=0" )"
    echo "==> gn gen ($cpu)"
    gn gen "$local_out" --args="$args"
    echo "==> ninja ($cpu)"
    ninja -C "$local_out" pdfium -v
  done

  echo "==> Creating universal lib..."
  mkdir -p "$OUT_DIR/macos/$CONFIG/lib"
  lipo -create \
    "$OUT_DIR/macos-x64-$CONFIG/obj/libpdfium.a" \
    "$OUT_DIR/macos-arm64-$CONFIG/obj/libpdfium.a" \
    -o "$OUT_DIR/macos/$CONFIG/lib/libpdfium.a"

  echo "==> Copying headers (preserve public/ layout)..."
  mkdir -p "$OUT_DIR/macos/$CONFIG/include"
  cp -R "$PDFIUM_DIR/public" "$OUT_DIR/macos/$CONFIG/include/public"

  echo "macOS output -> $OUT_DIR/macos/$CONFIG"
}

apply_ios_patches() {
  echo "==> Applying small iOS patches (inline)"
  local root="$PDFIUM_DIR"
  local rules="$root/build/config/ios/rules.gni"
  local fxge="$root/core/fxge/BUILD.gn"
  local ios_overrides="$root/build/config/ios/ios_sdk_overrides.gni"

  if [ -f "$rules" ]; then
    sed_inplace 's#data_deps += \[ "//testing/iossim" \]##' "$rules" || true
  fi

  if [ -f "$fxge" ]; then
    sed_inplace 's#if (is_mac) {#if (is_mac || is_ios) {#' "$fxge" || true
  fi

  if [ -f "$ios_overrides" ] && ! grep -q 'ios_automatically_manage_certs' "$ios_overrides"; then
    echo 'if (is_ios) { ios_automatically_manage_certs = true }' >> "$ios_overrides"
  fi
}

build_ios() {
  echo "==> Building for iOS ($CONFIG)"
  command -v xcodebuild >/dev/null || { echo "xcodebuild required for iOS"; exit 1; }
  cd "$PDFIUM_DIR"
  apply_ios_patches

  for combo in "arm64 device" "x64 simulator" "arm64 simulator"; do
    cpu="$(echo "$combo" | awk '{print $1}')"
    env="$(echo "$combo" | awk '{print $2}')"
    local_out="$OUT_DIR/ios-$cpu-$env-$CONFIG"
    mkdir -p "$local_out"
    args="$(base_args ios "$cpu")
ios_enable_code_signing=false
use_blink=true
pdf_is_standalone=false
use_custom_libcxx=false
pdf_is_complete_lib=true
target_environment=\"$env\"
ios_deployment_target=\"12.0\"
$( [ "$CONFIG" = "release" ] && echo "symbol_level=0" )"
    echo "==> gn gen ($cpu-$env)"
    gn gen "$local_out" --args="$args"
    echo "==> ninja ($cpu-$env)"
    ninja -C "$local_out" pdfium -v
  done

  echo "==> Prepare outputs..."
  BASE_OUT="$OUT_DIR/ios/$CONFIG"
  mkdir -p "$BASE_OUT/lib/device" "$BASE_OUT/lib/simulator" "$BASE_OUT/include"

  cp -f "$OUT_DIR/ios-arm64-device-$CONFIG/obj/libpdfium.a" \
        "$BASE_OUT/lib/device/libpdfium.a"

  lipo -create \
    "$OUT_DIR/ios-x64-simulator-$CONFIG/obj/libpdfium.a" \
    "$OUT_DIR/ios-arm64-simulator-$CONFIG/obj/libpdfium.a" \
    -o "$BASE_OUT/lib/simulator/libpdfium.a"

  echo "==> Copying headers (preserve public/ layout)..."
  cp -R "$PDFIUM_DIR/public" "$BASE_OUT/include/public"

  echo "==> Creating xcframework..."
  rm -rf "$BASE_OUT/pdfium.xcframework"
  xcodebuild -create-xcframework \
    -library "$BASE_OUT/lib/device/libpdfium.a" -headers "$BASE_OUT/include" \
    -library "$BASE_OUT/lib/simulator/libpdfium.a" -headers "$BASE_OUT/include" \
    -output "$BASE_OUT/pdfium.xcframework"

  echo "iOS output -> $BASE_OUT"
}

build_android() {
  echo "==> Building for Android ($CONFIG)"
  # On macOS, upstream only supports building Android on Linux. Fallback to Docker if available.
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "Android builds are only supported on Linux by upstream."
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      echo "==> Using Docker fallback to build on Linux toolchain..."
      build_android_docker
      return
    else
      echo "Install Docker or run this on a Linux host." >&2
      exit 1
    fi
  fi

  cd "$PDFIUM_DIR"

  for cpu in arm arm64 x86 x64; do
    local_out="$OUT_DIR/android-$cpu-$CONFIG"
    mkdir -p "$local_out"
    args="$(base_args android "$cpu")
clang_use_chrome_plugins=false
default_min_sdk_version=21
pdf_is_standalone=true
pdf_bundle_freetype=true
pdf_is_complete_lib=true
use_allocator_shim=false
use_custom_libcxx=false
$( [ "$CONFIG" = "release" ] && echo "symbol_level=0" )"
    echo "==> gn gen ($cpu)"
    gn gen "$local_out" --args="$args"
    echo "==> ninja ($cpu)"
    ninja -C "$local_out" pdfium -v
  done

  echo "==> Collecting outputs..."
  BASE_OUT="$OUT_DIR/android/$CONFIG"
  declare -A cpu_to_abi=( [arm]="armeabi-v7a" [arm64]="arm64-v8a" [x86]="x86" [x64]="x86_64" )
  for cpu in arm arm64 x86 x64; do
    abi="${cpu_to_abi[$cpu]}"
    mkdir -p "$BASE_OUT/lib/$abi"
    cp -f "$OUT_DIR/android-$cpu-$CONFIG/obj/libpdfium.a" \
          "$BASE_OUT/lib/$abi/libpdfium.a"
  done

  echo "Android output -> $BASE_OUT"
}

# -----------------------------
# WASM (delegates to pdfium-lib + Docker)
# -----------------------------
build_wasm() {
  echo "==> Building for WASM via pdfium-lib Docker flow"

  local LIB_DIR="$ROOT/pdfium-lib"
  if [ ! -d "$LIB_DIR/.git" ]; then
    echo "==> Cloning pdfium-lib..."
    git clone https://github.com/paulocoutinhox/pdfium-lib.git "$LIB_DIR"
  else
    echo "==> Updating pdfium-lib..."
    (cd "$LIB_DIR" && git fetch --all -p && git pull --rebase) || true
  fi

  cd "$LIB_DIR"

  echo "==> Building Docker image pdfium-wasm..."
  docker build --platform linux/amd64 -t pdfium-wasm -f docker/wasm/Dockerfile docker/wasm

  echo "==> Sanity run..."
  docker run --platform linux/amd64 -v "${PWD}:/app" -it pdfium-wasm echo "test"

  echo "==> Running full WASM pipeline inside container..."
 docker run --platform linux/amd64 -v "$PWD:/app" -w /app -it pdfium-wasm bash -lc '
  set -euo pipefail

  # Keep it steady for first build to populate cache
  export PIP_ROOT_USER_ACTION=ignore
  export NINJAFLAGS="-j1"                     # outer parallelism low for warmup
  export EM_CACHE="/tmp/emscripten-cache"     # private cache (not on bind mount)
  export EMCC_CORES=1                         # no internal emcc parallelism

  # depot_tools (allow bootstrap) + emsdk
  python3 -m pip install -r requirements.txt
  python3 make.py build-depot-tools
  export PATH="$PWD/build/depot-tools:$PATH"
  ensure_bootstrap || true
  update_depot_tools -v || true
  gclient --version >/dev/null 2>&1 || true

  mkdir -p build && cd build
  test -d emsdk || git clone https://github.com/emscripten-core/emsdk.git emsdk
  cd emsdk && ./emsdk install 4.0.10 && ./emsdk activate 4.0.10 && . ./emsdk_env.sh

  export EM_CACHE="/tmp/emscripten-cache"
  mkdir -p "$EM_CACHE"
  rm -rf "$EMSDK/upstream/emscripten/cache"
  ln -s "$EM_CACHE" "$EMSDK/upstream/emscripten/cache"


  # sanity + warm the (private) cache
  emcc --clear-cache || true
  emcc --check >/dev/null
  echo "int main(){return 0;}" > /tmp/t.c
  emcc -c /tmp/t.c -o /tmp/t.o >/dev/null

  cd /app

  # pdfium-lib flow (GN/Ninja run inside these)
  python3 make.py build-pdfium-wasm
  python3 make.py patch-wasm
  ./build/emscripten/pdfium/build/install-build-deps.sh
  python3 make.py build-wasm
  python3 make.py install-wasm
  # python3 make.py test-wasm
  python3 make.py generate-wasm
'

SRC="$LIB_DIR/build/emscripten/wasm/release/node"
: "${OUT_DIR:?OUT_DIR is not set}"   # require OUT_DIR
DST="$OUT_DIR/wasm"

# Make target folder if missing
mkdir -p "$DST"

# Copy *contents* of $SRC (incl. hidden files) into $DST
# The "/." trick copies everything inside SRC; -a preserves attrs.
cp -a "$SRC"/. "$DST"/
  
  echo "WASM build via pdfium-lib completed. Check artifacts inside: $LIB_DIR"
}

# Build Android via Docker (Linux environment) when on macOS
build_android_docker() {
  local image_tag="pdfium-android"
  # Prefer repo Dockerfile if present; else generate a minimal one on the fly
  if [ -f "$ROOT/docker/android/Dockerfile" ]; then
    echo "==> Building Docker image ($image_tag) using docker/android/Dockerfile..."
    # Force linux/amd64 to ensure CIPD packages (e.g., reclient) resolve
    docker build --platform linux/amd64 -t "$image_tag" -f "$ROOT/docker/android/Dockerfile" "$ROOT"
  else
    echo "==> Building Docker image ($image_tag) using ephemeral Dockerfile..."
    tmpdir="$(mktemp -d)"
    cat >"$tmpdir/Dockerfile" <<'EOF'
FROM ubuntu:22.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get -y update && apt-get install -y git curl unzip python3 python3-pip build-essential ninja-build file ca-certificates pkg-config openjdk-17-jdk cmake zip --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_WIN_TOOLCHAIN=0
RUN git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git -b main /opt/depot-tools
ENV PATH=/opt/depot-tools:$PATH
WORKDIR /work
EOF
    # Force linux/amd64 to ensure CIPD packages (e.g., reclient) resolve
    docker build --platform linux/amd64 -t "$image_tag" "$tmpdir"
    rm -rf "$tmpdir"
  fi

  echo "==> Running Android build in container... This can take a while."
  : <<'DISABLED_OLD_INLINE'
  docker run --platform linux/amd64 --rm \
    -e PDFIUM_BRANCH="$PDFIUM_BRANCH" \
    -e CONFIG="$CONFIG" \
    -e IS_DEBUG="$is_debug" \
    -v "$ROOT":/work \
    -w /work "$image_tag" bash -lc '
set -euo pipefail
export PATH=/opt/depot-tools:$PATH
# Ensure depot_tools bootstraps its CIPD-managed python and tools
if command -v ensure_bootstrap >/dev/null 2>&1; then
  ensure_bootstrap || true
else
  /opt/depot-tools/ensure_bootstrap || true
fi
update_depot_tools -v || true
SRC=/work/src-android
mkdir -p "$SRC"
cd "$SRC"
if [ ! -d pdfium ]; then
  gclient config --unmanaged https://pdfium.googlesource.com/pdfium.git --custom-var checkout_configuration=minimal
  echo "target_os = [ \"android\" ]" >> .gclient
fi
gclient sync -r "origin/${PDFIUM_BRANCH}" --no-history --shallow
  cd pdfium

  # Inject a small GN target to build our JNI bridge with the same toolchain
  if [ -f /work/sdk/android/pdfcora/src/main/cpp/pdfcora_jni.cpp ]; then
    mkdir -p third_party/pdfcora
    cp -f /work/sdk/android/pdfcora/src/main/cpp/pdfcora_jni.cpp third_party/pdfcora/pdfcora_jni.cpp
    cat > third_party/pdfcora/BUILD.gn <<GN
import("//build/config/android/rules.gni")

shared_library("pdfcora") {
  sources = [ "pdfcora_jni.cpp" ]
  include_dirs = [ "//public" ]
  deps = [ "//:pdfium" ]
  libs = [ "log", "android", "jnigraphics" ]
}
GN
    # Ensure the target is reachable by the root build graph
    if ! grep -q "group\(\"pdfcora_aggregate\"\)" BUILD.gn; then
      cat >> BUILD.gn <<GNROOT

group("pdfcora_aggregate") {
  if (is_android) {
    deps = [ "//third_party/pdfcora:pdfcora" ]
  }
}
GNROOT
    fi
  fi

  for cpu in arm arm64 x86 x64; do
    out_dir="/work/out/android-${cpu}-${CONFIG}"
    mkdir -p "$out_dir"
  gn gen "$out_dir" --args="is_debug=${IS_DEBUG} pdf_enable_v8=false pdf_enable_xfa=false target_os=\"android\" target_cpu=\"${cpu}\" clang_use_chrome_plugins=false default_min_sdk_version=21 pdf_is_standalone=true pdf_bundle_freetype=true pdf_is_complete_lib=true $( [ "$CONFIG" = "release" ] && echo symbol_level=0 )"
    ninja -C "$out_dir" pdfium -v
    if [ -f third_party/pdfcora/pdfcora_jni.cpp ]; then
      # Build our JNI shared library using the same toolchain
      ninja -C "$out_dir" pdfcora -v || true
      # If GN target wasn't wired into the graph, fall back to direct NDK clang link
      if [ ! -f "$out_dir/libpdfcora.so" ] && [ ! -f "$out_dir/obj/third_party/pdfcora/libpdfcora.so" ]; then
        echo "==> Fallback: building libpdfcora.so via NDK clang"
        NDK="$(pwd)/third_party/android_ndk"
        CLANG="$NDK/toolchains/llvm/prebuilt/linux-x64/bin/clang++"
        SYSROOT="$NDK/toolchains/llvm/prebuilt/linux-x64/sysroot"
        case "$cpu" in
          arm) target=armv7a-linux-androideabi21;;
          arm64) target=aarch64-none-linux-android21;;
          x86) target=i686-linux-android21;;
          x64) target=x86_64-linux-android21;;
        esac
        "$CLANG" --target="$target" --sysroot="$SYSROOT" -fPIC -shared \
          -I "$(pwd)/public" \
          third_party/pdfcora/pdfcora_jni.cpp \
          "$out_dir/obj/libpdfium.a" \
          -landroid -llog -ljnigraphics -lc++_shared -latomic -lm \
          -Wl,--no-rosegment -Wl,--no-undefined-version -Wl,--fatal-warnings \
          -o "$out_dir/libpdfcora.so"
      fi
      # Copy built .so into the Android module jniLibs for packaging
      case "$cpu" in
        arm) abi=armeabi-v7a;;
        arm64) abi=arm64-v8a;;
        x86) abi=x86;;
        x64) abi=x86_64;;
      esac
      mkdir -p "/work/sdk/android/pdfcora/src/main/jniLibs/$abi"
      if [ -f "$out_dir/libpdfcora.so" ]; then
        cp -f "$out_dir/libpdfcora.so" "/work/sdk/android/pdfcora/src/main/jniLibs/$abi/libpdfcora.so"
      elif [ -f "$out_dir/obj/third_party/pdfcora/libpdfcora.so" ]; then
        cp -f "$out_dir/obj/third_party/pdfcora/libpdfcora.so" "/work/sdk/android/pdfcora/src/main/jniLibs/$abi/libpdfcora.so"
      fi
    fi
done
BASE_OUT="/work/out/android/${CONFIG}"
mkdir -p "$BASE_OUT"
declare -A map=([arm]=armeabi-v7a [arm64]=arm64-v8a [x86]=x86 [x64]=x86_64)
for cpu in arm arm64 x86 x64; do
  abi="${map[$cpu]}"
  mkdir -p "$BASE_OUT/lib/$abi"
  cp -f "/work/out/android-${cpu}-${CONFIG}/obj/libpdfium.a" "$BASE_OUT/lib/$abi/libpdfium.a"
done
echo "Android output -> $BASE_OUT"
'
DISABLED_OLD_INLINE

  # New path: run inner script file from host to avoid quoting issues
  docker run --platform linux/amd64 --rm \
    -e PDFIUM_BRANCH="$PDFIUM_BRANCH" \
    -e CONFIG="$CONFIG" \
    -e IS_DEBUG="$is_debug" \
    -v "$ROOT":/work \
    -w /work "$image_tag" bash /work/docker/android/build_android_inner.sh
}

build_linux_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
    echo "Linux builds run in a container. Install Docker, or run this script on Linux." >&2
    exit 1
  }

  local image_tag="pdfium-linux"
  echo "==> Building Docker image ($image_tag)..."
  tmpdir="$(mktemp -d)"
  cat >"$tmpdir/Dockerfile" <<'EOF'
FROM ubuntu:22.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get -y update && apt-get install -y git curl unzip python3 python3-pip build-essential ninja-build file ca-certificates pkg-config cmake zip lsb-release sudo --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV DEPOT_TOOLS_UPDATE=0 DEPOT_TOOLS_WIN_TOOLCHAIN=0
RUN git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git -b main /opt/depot-tools
ENV PATH=/opt/depot-tools:$PATH
WORKDIR /work
EOF
  # linux/amd64 so the CIPD packages depot_tools fetches resolve, whatever the host is.
  docker build --platform linux/amd64 -t "$image_tag" "$tmpdir"
  rm -rf "$tmpdir"

  echo "==> Running Linux build in container... This can take a while."
  docker run --platform linux/amd64 --rm \
    -e PDFIUM_BRANCH="$PDFIUM_BRANCH" \
    -e CONFIG="$CONFIG" \
    -e IS_DEBUG="$is_debug" \
    -v "$ROOT":/work \
    -w /work "$image_tag" bash /work/docker/linux/build_linux_inner.sh
}

main() {
  case "$PLATFORM" in
    macos)
      ensure_depot_tools
      gclient_config_sync "'mac'"
      build_macos
      ;;
    linux)
      build_linux_docker
      ;;
    ios)
      ensure_depot_tools
      gclient_config_sync "'ios'"
      build_ios
      ;;
    android)
      # On macOS, avoid running host gclient; use Docker path early if available.
      if [ "$(uname -s)" = "Darwin" ]; then
        if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
          build_android_docker
          return 0
        else
          echo "Android builds require Linux toolchain. Install Docker or run on Linux." >&2
          exit 1
        fi
      fi
      setup_android_sandbox_env
      ensure_depot_tools
      gclient_config_sync "'android'"
      build_android
      ;;
    wasm)
      # No host depot_tools/emsdk required; fully handled by pdfium-lib Docker image
      build_wasm
      ;;
    *)
      echo "Unknown platform: $PLATFORM (use: macos | linux | ios | android | wasm)"; exit 1 ;;
  esac

  echo "==> Done."
}

main "$@"
