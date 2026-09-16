#!/usr/bin/env bash
# Builds PDFium for Linux inside the container. Mirrors build_macos(), which is the
# same job with a different target_os, and writes to /work/out like every other target.
set -euo pipefail

export PATH=/opt/depot-tools:$PATH
if command -v ensure_bootstrap >/dev/null 2>&1; then
  ensure_bootstrap || true
else
  /opt/depot-tools/ensure_bootstrap || true
fi
update_depot_tools -v || true

SRC=/work/src-linux
mkdir -p "$SRC"
cd "$SRC"
# A clean checkout each time, as the Android build does: gclient refuses to sync a
# tree with local modifications, and the cost is paid once per container run.
if [ -d pdfium ]; then
  echo "==> Removing existing pdfium checkout to avoid local changes"
  rm -rf pdfium
fi
gclient config --unmanaged https://pdfium.googlesource.com/pdfium.git --custom-var checkout_configuration=minimal
gclient sync -r "origin/${PDFIUM_BRANCH}" --no-history --shallow
cd pdfium

for cpu in x64 arm64; do
  out_dir="/work/out/linux-${cpu}-${CONFIG}"
  mkdir -p "$out_dir"
  # use_sysroot=true is the difference from the macOS args: Chromium's sysroot is what
  # makes the result run on older glibc than the build container's.
  gn gen "$out_dir" --args="is_debug=${IS_DEBUG}
treat_warnings_as_errors=false
is_component_build=false
pdf_use_partition_alloc=false
pdf_enable_v8=false
pdf_enable_xfa=false
target_os=\"linux\"
target_cpu=\"${cpu}\"
pdf_is_standalone=true
use_custom_libcxx=false
use_sysroot=true
use_allocator_shim=false
pdf_bundle_freetype=true
pdf_is_complete_lib=true
clang_use_chrome_plugins=false
$( [ "$CONFIG" = "release" ] && echo symbol_level=0 )"
  ninja -C "$out_dir" pdfium -v
done

echo "==> Collecting artifacts"
for cpu in x64 arm64; do
  dest="/work/out/linux/${CONFIG}/${cpu}"
  mkdir -p "$dest"
  cp "/work/out/linux-${cpu}-${CONFIG}/obj/libpdfium.a" "$dest/libpdfium.a"
done
mkdir -p "/work/out/linux/${CONFIG}/include"
cp -R public "/work/out/linux/${CONFIG}/include/public"
echo "Linux output -> /work/out/linux/${CONFIG}"
