#!/usr/bin/env bash
# Builds the distributable artifacts for every SDK into one directory.
#
#   ./scripts/package-all.sh [outdir]        (default: build/dist)
#
# Produces:
#   ios/PDFCora.xcframework.zip     self-contained framework, pdfium linked in
#   ios/pdfium.xcframework.zip        the binary target for SPM consumers, + checksum
#   android/pdfcora-release.aar     all four ABIs
#   android/maven/                    a repository the AAR resolves from
#   web/pdfcora-web-<version>.tgz   npm tarball, wasm included
#   node/pdfcora-node-<version>.tgz npm tarball, depending on the published web package
#   java/pdfcora-<version>.jar      the jar, with a native library per platform
#   java/maven/                       a repository the jar resolves from
#   SHA256SUMS, NOTICE.md, README.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(cd "$(dirname "${1:-$ROOT/build/dist}")" && pwd)/$(basename "${1:-dist}")"
WORK="$OUT/.work"
DEST_IOS="${PDFCORA_IOS_DESTINATIONS:-generic/platform=iOS Simulator|generic/platform=iOS}"

for d in ios android web; do
    [ -d "$ROOT/vendor/$d" ] || { echo "missing vendor/$d — run ./scripts/fetch-vendor.sh" >&2; exit 1; }
done

rm -rf "$OUT"
mkdir -p "$OUT"/{ios,android,web,node,java} "$WORK"

# --- iOS ------------------------------------------------------------------------
# xcodebuild only emits a real framework for a dynamic product, and SPM forbids target
# paths outside the package, so the framework is archived from a staging package of
# symlinks rather than by editing the real Package.swift.
echo "==> iOS"
STAGE="$WORK/stage"
mkdir -p "$STAGE/Sources" "$STAGE/vendor"
ln -sf "$ROOT/ios/Sources/PDFCora" "$STAGE/Sources/PDFCora"
ln -sf "$ROOT/ios/Sources/CPdfium"   "$STAGE/Sources/CPdfium"
ln -sf "$ROOT/vendor/ios/pdfium.xcframework" "$STAGE/vendor/pdfium.xcframework"
cat > "$STAGE/Package.swift" <<'EOF'
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PDFCora",
    platforms: [.iOS(.v15)],
    products: [.library(name: "PDFCora", type: .dynamic, targets: ["PDFCora"])],
    targets: [
        .binaryTarget(name: "pdfium", path: "vendor/pdfium.xcframework"),
        .target(name: "CPdfium", dependencies: ["pdfium"], path: "Sources/CPdfium",
                publicHeadersPath: "include"),
        .target(name: "PDFCora", dependencies: ["CPdfium"], path: "Sources/PDFCora"),
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
    ( cd "$STAGE" && xcodebuild archive -scheme PDFCora -destination "$destination" \
        -archivePath "$archive" -derivedDataPath "$derived" \
        SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES ) > "$WORK/$slice.log" 2>&1 \
        || { echo "archive failed for $destination — see $WORK/$slice.log" >&2; exit 1; }

    framework="$archive/Products/usr/local/lib/PDFCora.framework"
    # A dynamic SPM product archives without its .swiftmodule, so consumers could not
    # import it. Copy the one the build emitted alongside.
    module="$(find "$derived" -type d -path "*Release-$sdk/PDFCora.swiftmodule" | head -1)"
    [ -n "$module" ] || { echo "no PDFCora.swiftmodule for $slice" >&2; exit 1; }
    mkdir -p "$framework/Modules"
    cp -R "$module" "$framework/Modules/"
    frameworks+=(-framework "$framework")
    echo "    $slice: $(du -h "$framework/PDFCora" | cut -f1)"
done

xcodebuild -create-xcframework "${frameworks[@]}" -output "$WORK/PDFCora.xcframework" > /dev/null
( cd "$WORK" && zip -qr "$OUT/ios/PDFCora.xcframework.zip" PDFCora.xcframework )

( cd "$ROOT/vendor/ios" && zip -qr "$OUT/ios/pdfium.xcframework.zip" pdfium.xcframework )
CHECKSUM=$(swift package --package-path "$ROOT" compute-checksum "$OUT/ios/pdfium.xcframework.zip")
cat > "$OUT/ios/binary-target.swift" <<EOF
// For an SPM release, replace the local .binaryTarget in Package.swift with:
.binaryTarget(
    name: "pdfium",
    url: "https://github.com/<owner>/PDFCora/releases/download/<tag>/pdfium.xcframework.zip",
    checksum: "$CHECKSUM"
),
EOF

# --- Android --------------------------------------------------------------------
echo "==> Android"
( cd "$ROOT/android" && gradle :pdfcora:assembleRelease \
    :pdfcora:publishReleasePublicationToDistRepository \
    -PdistRepo="$OUT/android/maven" --console=plain ) > "$WORK/android.log" 2>&1 \
    || { echo "gradle failed — see $WORK/android.log" >&2; exit 1; }
cp "$ROOT/android/pdfcora/build/outputs/aar/pdfcora-release.aar" "$OUT/android/"
echo "    abis: $(unzip -l "$OUT/android/pdfcora-release.aar" | grep -c 'jni/.*\.so$')"

# --- Web ------------------------------------------------------------------------
echo "==> Web"
( cd "$ROOT/web" && npm pack --pack-destination "$OUT/web" ) > "$WORK/web.log" 2>&1 \
    || { echo "npm pack failed — see $WORK/web.log" >&2; exit 1; }

# --- Node -----------------------------------------------------------------------
# Packed from a copy: the working tree depends on ../web by path, which no consumer of
# the tarball can resolve. The copy names the published version instead.
echo "==> Node"
NODE_STAGE="$WORK/node-stage"
mkdir -p "$NODE_STAGE"
( cd "$ROOT/node" && npm run build ) > "$WORK/node-build.log" 2>&1 \
    || { echo "node build failed — see $WORK/node-build.log" >&2; exit 1; }
cp "$ROOT/node/package.json" "$ROOT/node/README.md" "$NODE_STAGE/"
cp -R "$ROOT/node/dist" "$NODE_STAGE/dist"
python3 - "$NODE_STAGE/package.json" <<'PYEOF'
import json, sys
package = json.load(open(sys.argv[1]))
package["dependencies"]["@pdfcora/web"] = "^" + package["version"]
# The copy has no node_modules, and dist is already in it, so the prepack build
# would only fail.
package.get("scripts", {}).pop("prepack", None)
json.dump(package, open(sys.argv[1], "w"), indent=2)
PYEOF
( cd "$NODE_STAGE" && npm pack --pack-destination "$OUT/node" ) > "$WORK/node.log" 2>&1 \
    || { echo "npm pack failed — see $WORK/node.log" >&2; exit 1; }

# --- Java -----------------------------------------------------------------------
echo "==> Java"
if [ -d "$ROOT/java/src/main/resources/native" ]; then
    ( cd "$ROOT/java" && gradle jar publishMavenPublicationToDistRepository \
        -PdistRepo="$OUT/java/maven" --console=plain ) > "$WORK/java.log" 2>&1 \
        || { echo "gradle failed — see $WORK/java.log" >&2; exit 1; }
    cp "$ROOT"/java/build/libs/*.jar "$OUT/java/"
    JAR="$(ls "$OUT"/java/*.jar | grep -v -e -sources.jar -e -javadoc.jar | head -1)"
    echo "    platforms: $(unzip -l "$JAR" | grep -cE 'native/.*\.(so|dylib)$')"
else
    # A jar without an engine would look like a release and fail at the first call.
    echo "    skipped: no native engine — run ./scripts/build-jni.sh" >&2
    rmdir "$OUT/java"
fi

# --- Manifest -------------------------------------------------------------------
cp "$ROOT/NOTICE.md" "$OUT/"
cat > "$OUT/README.md" <<EOF
# PDFCora distribution

Built $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "untracked").
Third-party licences are in NOTICE.md — FreeType's credit line is required in your docs.

## iOS
Drag \`PDFCora.xcframework\` into your target and embed it. pdfium is linked in;
there is nothing else to add. For SPM instead, host \`pdfium.xcframework.zip\` and use
the snippet in \`binary-target.swift\`.

## Android
\`\`\`kotlin
repositories { maven { url = uri("<path to android/maven>") } }
dependencies { implementation("com.pdfcora:pdfcora:0.1.0") }
\`\`\`
Or drop \`pdfcora-release.aar\` into \`libs/\`.

## Web
\`\`\`
npm install ./web/$(basename "$(ls "$OUT/web"/*.tgz)")
\`\`\`
The \`.wasm\` ships inside the package; serve it from the same origin.

## Node
\`\`\`
npm install ./node/$(basename "$(ls "$OUT/node"/*.tgz)")
\`\`\`
It depends on \`@pdfcora/web\`, which resolves from the registry or from the tarball
above.

## Java
\`\`\`kotlin
repositories { maven { url = uri("<path to java/maven>") } }
dependencies { implementation("com.pdfcora:pdfcora-java:0.1.0") }
\`\`\`
Or put the jar on the classpath. It carries a native library for macOS and Linux on
x86-64 and arm64; \`-Dpdfcora.native.path=\` overrides which one is loaded.
EOF

( cd "$OUT" && find . -type f ! -name SHA256SUMS ! -path "./.work/*" -print0 \
    | sort -z | xargs -0 shasum -a 256 > SHA256SUMS )
rm -rf "$WORK"

echo
echo "distribution: $OUT"
find "$OUT" -maxdepth 2 -type f | sed "s|$OUT/|  |"
