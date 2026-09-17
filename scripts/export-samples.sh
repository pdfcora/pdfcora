#!/usr/bin/env bash
# Writes the public copy of samples/ (github.com/pdfcora/samples).
#
#   ./scripts/export-samples.sh [outdir]      (default: build/samples-public)
#
# In this repository the samples build against the SDK's source folders. The public
# copy depends on the released packages instead: Swift Package Manager, Maven Central,
# npm, and jsDelivr for the browser samples. Only tracked files are copied.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/samples-public}"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$ROOT/android/pdfcora/build.gradle.kts")"

command -v xcodegen > /dev/null || { echo "xcodegen is needed: brew install xcodegen" >&2; exit 1; }
# Keep an existing clone's history when exporting into one.
[ -d "$OUT" ] && find "$OUT" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
mkdir -p "$OUT"
( cd "$ROOT/samples" && git ls-files -z . | xargs -0 -I{} rsync -R {} "$OUT/" )
find "$OUT" -name package-lock.json -delete

python3 - "$OUT" "$VERSION" <<'EOF'
import json, os, re, sys
out, version = sys.argv[1:]
cdn = f"https://cdn.jsdelivr.net/npm/@pdfcora/{{}}@{version}/"

def edit(path, change):
    with open(path) as f:
        before = f.read()
    after = change(before)
    if after != before:
        with open(path, "w") as f:
            f.write(after)

def readme(text):
    # <!-- repo -->…<!-- /repo --> is for this repository only; <!-- public … --> replaces it.
    text = re.sub(r"<!-- repo -->\n.*?<!-- /repo -->\n", "", text, flags=re.S)
    return re.sub(r"<!-- public\n(.*?)-->\n", r"\1", text, flags=re.S)

def browser(text):
    for package in ("web-ai", "web"):
        text = text.replace(f"../../{package}/", cdn.format(package))
    return text.replace("new URL('../../mcp/dist/main.js', import.meta.url)",
                        "new URL('node_modules/pdfcora-mcp/dist/main.js', import.meta.url)")

def settings(text):
    return re.sub(r"\n(//[^\n]*\n)*includeBuild\([^\n]*\n(\s*\{.*?\n\})?\n?", "\n", text, flags=re.S)

def xcodegen(text):
    return re.sub(r"(\n  PDFCora:\n)    path: \.\./\.\.\n",
                  rf"\1    url: https://github.com/pdfcora/pdfcora-swift\n    from: {version}\n", text)

for dirpath, _, files in os.walk(out):
    if ".git" in dirpath.split(os.sep):
        continue
    for name in files:
        path = os.path.join(dirpath, name)
        if name == "README.md":
            edit(path, readme)
        elif name.endswith((".js", ".mjs", ".html")):
            edit(path, browser)
        elif name == "settings.gradle.kts":
            edit(path, settings)
        elif name == "project.yml":
            edit(path, xcodegen)
        elif name == "package.json":
            package = json.load(open(path))
            dependencies = package.setdefault("dependencies", {})
            for dep, spec in dependencies.items():
                if spec.startswith("file:"):
                    dependencies[dep] = "^" + version
            if os.path.basename(dirpath) == "agents-web":
                dependencies["pdfcora-mcp"] = "^" + version
            with open(path, "w") as f:
                f.write(json.dumps(package, indent=2) + "\n")

leftovers = []
for dirpath, _, files in os.walk(out):
    if ".git" in dirpath.split(os.sep):
        continue
    for name in files:
        if name.endswith((".pdf", ".png", ".p12")):
            continue
        text = open(os.path.join(dirpath, name), errors="ignore").read()
        for marker in ("../..", "<!-- repo", "<!-- public", "fetch-vendor", "build-jni", '"file:'):
            if marker in text:
                leftovers.append(f"{os.path.relpath(os.path.join(dirpath, name), out)}: {marker}")
if leftovers:
    print("still bound to the private repository:\n  " + "\n  ".join(leftovers), file=sys.stderr)
    sys.exit(1)
EOF

cat > "$OUT/.gitignore" <<'EOF'
node_modules/
build/
.gradle/
local.properties
*.xcodeproj/xcuserdata/
*.xcodeproj/project.xcworkspace/xcuserdata/
.DS_Store
EOF

# The Xcode projects are generated rather than kept in this repository; the public copy
# ships them so a sample opens with a double-click.
for spec in "$OUT"/*-ios/project.yml; do
    ( cd "$(dirname "$spec")" && xcodegen generate --quiet )
done

echo "samples: $OUT ($(find "$OUT" -type f ! -path '*/.git/*' | wc -l | tr -d ' ') files)"
