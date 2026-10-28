#!/usr/bin/env bash
# Builds the binary Swift package that iOS apps install PDFCora from.
#
#   ./scripts/package-swift.sh [version]      (default: the version in android/pdfcora)
#
# Produces, in build/swift:
#   PDFCora.xcframework.zip, PDFCoraUI.xcframework.zip, PDFCoraAI.xcframework.zip
#   repo/     the public package repository (github.com/pdfcora/pdfcora-swift): a
#             Package.swift naming the zips above as release assets, with checksums
#   local/    the same package with the frameworks next to it, to build against before
#             anything is uploaded
#
# Each module is a dynamic framework. PDFCora carries PDFium; the UI and AI frameworks
# link against PDFCora rather than copying it, so an app has one copy of every type.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/android/pdfcora/build.gradle.kts")}"
OUT="$ROOT/build/swift"
WORK="$OUT/.work"
REPO_URL="https://github.com/pdfcora/pdfcora-swift"

[ -d "$ROOT/vendor/ios/pdfium.xcframework" ] || { echo "missing vendor/ios — run ./scripts/fetch-vendor.sh" >&2; exit 1; }
rm -rf "$OUT"
mkdir -p "$WORK" "$OUT/local"

# Archives one module from a staging package and turns it into an xcframework.
#   build_framework <module> <Package.swift body for the staging package>
build_framework() {
    local module="$1" manifest="$2" stage="$WORK/$1"
    mkdir -p "$stage/Sources"
    printf '%s\n' "$manifest" > "$stage/Package.swift"
    local frameworks=()
    for slice in simulator device; do
        local destination sdk
        if [ "$slice" = simulator ]; then destination="generic/platform=iOS Simulator"; sdk=iphonesimulator
        else destination="generic/platform=iOS"; sdk=iphoneos; fi
        local archive="$WORK/$module-$slice.xcarchive" derived="$WORK/dd-$module-$slice"
        ( cd "$stage" && xcodebuild archive -scheme "$module" -destination "$destination" \
            -archivePath "$archive" -derivedDataPath "$derived" \
            SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES ) > "$WORK/$module-$slice.log" 2>&1 \
            || { echo "archive failed: $module $slice — see $WORK/$module-$slice.log" >&2; exit 1; }
        local framework="$archive/Products/usr/local/lib/$module.framework"
        # A dynamic SPM product archives without its .swiftmodule, so nothing could
        # import it. Copy the one the build emitted.
        local swiftmodule
        swiftmodule="$(find "$derived" -type d -path "*Release-$sdk/$module.swiftmodule" | head -1)"
        [ -n "$swiftmodule" ] || { echo "no $module.swiftmodule for $slice" >&2; exit 1; }
        mkdir -p "$framework/Modules"
        cp -R "$swiftmodule" "$framework/Modules/"
        # Apps compile against the public interface only.
        find "$framework/Modules" \( -name '*.private.swiftinterface' -o -name '*.package.swiftinterface' \) -delete
        frameworks+=(-framework "$framework")
    done
    xcodebuild -create-xcframework "${frameworks[@]}" -output "$OUT/local/$module.xcframework" > /dev/null
    ( cd "$OUT/local" && zip -qry "$OUT/$module.xcframework.zip" "$module.xcframework" )
    echo "    $module: $(du -h "$OUT/$module.xcframework.zip" | cut -f1)"
}

echo "==> iOS frameworks $VERSION"
mkdir -p "$WORK/PDFCora/Sources" "$WORK/PDFCora/vendor"
ln -s "$ROOT/ios/Sources/PDFCora" "$WORK/PDFCora/Sources/PDFCora"
ln -s "$ROOT/ios/Sources/CPdfium" "$WORK/PDFCora/Sources/CPdfium"
ln -s "$ROOT/vendor/ios/pdfium.xcframework" "$WORK/PDFCora/vendor/pdfium.xcframework"
build_framework PDFCora '// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "PDFCora",
    platforms: [.iOS(.v15)],
    products: [.library(name: "PDFCora", type: .dynamic, targets: ["PDFCora"])],
    targets: [
        .binaryTarget(name: "pdfium", path: "vendor/pdfium.xcframework"),
        .target(name: "CPdfium", dependencies: ["pdfium"], path: "Sources/CPdfium", publicHeadersPath: "include"),
        .target(name: "PDFCora", dependencies: ["CPdfium"], path: "Sources/PDFCora"),
    ]
)'

for module in PDFCoraUI PDFCoraAI; do
    mkdir -p "$WORK/$module/Sources" "$WORK/$module/vendor"
    ln -s "$ROOT/ios/Sources/$module" "$WORK/$module/Sources/$module"
    ln -s "$OUT/local/PDFCora.xcframework" "$WORK/$module/vendor/PDFCora.xcframework"
    build_framework "$module" "// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: \"$module\",
    platforms: [.iOS(.v15)],
    products: [.library(name: \"$module\", type: .dynamic, targets: [\"$module\"])],
    targets: [
        .binaryTarget(name: \"PDFCora\", path: \"vendor/PDFCora.xcframework\"),
        .target(name: \"$module\", dependencies: [\"PDFCora\"], path: \"Sources/$module\"),
    ]
)"
done

# The package manifest, once with release URLs and once with local paths.
manifest() {
    local target
    cat <<EOF
// swift-tools-version: 5.9
// PDFCora for iOS, as prebuilt frameworks. https://pdfcora.pages.dev
import PackageDescription

let package = Package(
    name: "PDFCora",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "PDFCora", targets: ["PDFCora"]),
        .library(name: "PDFCoraUI", targets: ["PDFCoraUI", "PDFCora"]),
        .library(name: "PDFCoraAI", targets: ["PDFCoraAI", "PDFCora"]),
    ],
    targets: [
EOF
    for target in PDFCora PDFCoraUI PDFCoraAI; do
        if [ "$1" = release ]; then
            printf '        .binaryTarget(\n            name: "%s",\n            url: "%s/releases/download/%s/%s.xcframework.zip",\n            checksum: "%s"\n        ),\n' \
                "$target" "$REPO_URL" "$VERSION" "$target" \
                "$(swift package --package-path "$ROOT" compute-checksum "$OUT/$target.xcframework.zip")"
        else
            printf '        .binaryTarget(name: "%s", path: "%s.xcframework"),\n' "$target" "$target"
        fi
    done
    printf '    ]\n)\n'
}

mkdir -p "$OUT/repo"
manifest release > "$OUT/repo/Package.swift"
manifest local > "$OUT/local/Package.swift"
cp "$ROOT/LICENSE.md" "$ROOT/NOTICE.md" "$OUT/repo/"
cat > "$OUT/repo/README.md" <<EOF
# PDFCora for iOS

The [PDFCora](https://pdfcora.com) PDF SDK as a Swift package of prebuilt frameworks.

In Xcode, **File → Add Package Dependencies…**, enter
\`$REPO_URL\`, and add the products you use:

| Product | What it gives you |
| --- | --- |
| \`PDFCora\` | Render, text, search, forms, annotations, signatures, redaction, tags, save |
| \`PDFCoraUI\` | The SwiftUI viewer with its toolbar, theme and review bar |
| \`PDFCoraAI\` | Answers, summaries, redaction and form proposals, alt text, remediation, diff |

Or in \`Package.swift\`:

\`\`\`swift
.package(url: "$REPO_URL", from: "$VERSION"),
// …
.product(name: "PDFCora", package: "pdfcora-swift"),
\`\`\`

iOS 15 or newer. Documentation: https://pdfcora.com/developers.html · Samples:
https://github.com/pdfcora/samples

Licence: \`LICENSE.md\`. Third-party licences: \`NOTICE.md\`.
EOF
rm -rf "$WORK"
echo "package: $OUT/repo (release $VERSION: upload the three zips to $REPO_URL/releases/tag/$VERSION)"
