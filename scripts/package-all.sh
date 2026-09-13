#!/usr/bin/env bash
# Builds the distributable artifacts for all three platforms into one directory.
#
#   ./scripts/package-all.sh [outdir]        (default: build/dist)
#
# Produces:
#   ios/PdfiumKit.xcframework.zip     self-contained framework, pdfium linked in
#   ios/pdfium.xcframework.zip        the binary target for SPM consumers, + checksum
#   android/pdfiumkit-release.aar     all four ABIs
#   android/maven/                    a repository the AAR resolves from
#   web/pdfiumkit-web-<version>.tgz   npm tarball, wasm included
#   SHA256SUMS, NOTICE.md, README.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(cd "$(dirname "${1:-$ROOT/build/dist}")" && pwd)/$(basename "${1:-dist}")"
WORK="$OUT/.work"
DEST_IOS="${PDFIUMKIT_IOS_DESTINATIONS:-generic/platform=iOS Simulator|generic/platform=iOS}"

for d in ios android web; do
    [ -d "$ROOT/vendor/$d" ] || { echo "missing vendor/$d — run ./scripts/fetch-vendor.sh" >&2; exit 1; }
done

rm -rf "$OUT"
mkdir -p "$OUT"/{ios,android,web} "$WORK"

# --- iOS ------------------------------------------------------------------------
# xcodebuild only emits a real framework for a dynamic product, and SPM forbids target
# paths outside the package, so the framework is archived from a staging package of
# symlinks rather than by editing the real Package.swift.
echo "==> iOS"
STAGE="$WORK/stage"
mkdir -p "$STAGE/Sources" "$STAGE/vendor"
ln -sf "$ROOT/ios/Sources/PdfiumKit" "$STAGE/Sources/PdfiumKit"
ln -sf "$ROOT/ios/Sources/CPdfium"   "$STAGE/Sources/CPdfium"
ln -sf "$ROOT/vendor/ios/pdfium.xcframework" "$STAGE/vendor/pdfium.xcframework"
cat > "$STAGE/Package.swift" <<'EOF'
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PdfiumKit",
    platforms: [.iOS(.v15)],
    products: [.library(name: "PdfiumKit", type: .dynamic, targets: ["PdfiumKit"])],
    targets: [
        .binaryTarget(name: "pdfium", path: "vendor/pdfium.xcframework"),
        .target(name: "CPdfium", dependencies: ["pdfium"], path: "Sources/CPdfium",
                publicHeadersPath: "include"),
        .target(name: "PdfiumKit", dependencies: ["CPdfium"], path: "Sources/PdfiumKit"),
    ]
)
EOF

frameworks=()
IFS='|' read -ra destinations <<< "$DEST_IOS"
for destination in "${destinations[@]}"; do
    case "$destination" in
        *Simulator*) slice=simulator; sdk=iphonesimulator ;;
        *)           slice=device;    sdk=iphoneos ;;
    esac
    archive="$WORK/$slice.xcarchive"
    # Each slice needs its own derived data: a shared one is cleaned between archives,
    # taking the .swiftmodule with it.
    derived="$WORK/dd-$slice"
    ( cd "$STAGE" && xcodebuild archive -scheme PdfiumKit -destination "$destination" \
        -archivePath "$archive" -derivedDataPath "$derived" \
        SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES ) > "$WORK/$slice.log" 2>&1 \
        || { echo "archive failed for $destination — see $WORK/$slice.log" >&2; exit 1; }

    framework="$archive/Products/usr/local/lib/PdfiumKit.framework"
    # A dynamic SPM product archives without its .swiftmodule, so consumers could not
    # import it. Copy the one the build emitted alongside.
    module="$(find "$derived" -type d -path "*Release-$sdk/PdfiumKit.swiftmodule" | head -1)"
    [ -n "$module" ] || { echo "no PdfiumKit.swiftmodule for $slice" >&2; exit 1; }
    mkdir -p "$framework/Modules"
    cp -R "$module" "$framework/Modules/"
    frameworks+=(-framework "$framework")
    echo "    $slice: $(du -h "$framework/PdfiumKit" | cut -f1)"
done

xcodebuild -create-xcframework "${frameworks[@]}" -output "$WORK/PdfiumKit.xcframework" > /dev/null
( cd "$WORK" && zip -qr "$OUT/ios/PdfiumKit.xcframework.zip" PdfiumKit.xcframework )

( cd "$ROOT/vendor/ios" && zip -qr "$OUT/ios/pdfium.xcframework.zip" pdfium.xcframework )
CHECKSUM=$(swift package --package-path "$ROOT" compute-checksum "$OUT/ios/pdfium.xcframework.zip")
cat > "$OUT/ios/binary-target.swift" <<EOF
// For an SPM release, replace the local .binaryTarget in Package.swift with:
.binaryTarget(
    name: "pdfium",
    url: "https://github.com/<owner>/PdfiumKit/releases/download/<tag>/pdfium.xcframework.zip",
    checksum: "$CHECKSUM"
),
EOF

# --- Android --------------------------------------------------------------------
echo "==> Android"
( cd "$ROOT/android" && gradle :pdfiumkit:assembleRelease \
    :pdfiumkit:publishReleasePublicationToDistRepository \
    -PdistRepo="$OUT/android/maven" --console=plain ) > "$WORK/android.log" 2>&1 \
    || { echo "gradle failed — see $WORK/android.log" >&2; exit 1; }
cp "$ROOT/android/pdfiumkit/build/outputs/aar/pdfiumkit-release.aar" "$OUT/android/"
echo "    abis: $(unzip -l "$OUT/android/pdfiumkit-release.aar" | grep -c 'jni/.*\.so$')"

# --- Web ------------------------------------------------------------------------
echo "==> Web"
( cd "$ROOT/web" && npm pack --pack-destination "$OUT/web" ) > "$WORK/web.log" 2>&1 \
    || { echo "npm pack failed — see $WORK/web.log" >&2; exit 1; }

# --- Manifest -------------------------------------------------------------------
cp "$ROOT/NOTICE.md" "$OUT/"
cat > "$OUT/README.md" <<EOF
# PdfiumKit distribution

Built $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "untracked").
Third-party licences are in NOTICE.md — FreeType's credit line is required in your docs.

## iOS
Drag \`PdfiumKit.xcframework\` into your target and embed it. pdfium is linked in;
there is nothing else to add. For SPM instead, host \`pdfium.xcframework.zip\` and use
the snippet in \`binary-target.swift\`.

## Android
\`\`\`kotlin
repositories { maven { url = uri("<path to android/maven>") } }
dependencies { implementation("com.pdfiumkit:pdfiumkit:0.1.0") }
\`\`\`
Or drop \`pdfiumkit-release.aar\` into \`libs/\`.

## Web
\`\`\`
npm install ./web/$(basename "$(ls "$OUT/web"/*.tgz)")
\`\`\`
The \`.wasm\` ships inside the package; serve it from the same origin.
EOF

( cd "$OUT" && find . -type f ! -name SHA256SUMS ! -path "./.work/*" -print0 \
    | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )
rm -rf "$WORK"

echo
echo "distribution: $OUT"
find "$OUT" -maxdepth 2 -type f | sed "s|$OUT/|  |"
