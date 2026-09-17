#!/usr/bin/env bash
# Packs the npm packages for release, and optionally publishes them.
#
#   ./scripts/publish-npm.sh              pack into build/npm and check the tarballs
#   ./scripts/publish-npm.sh --publish    also publish them (needs `npm login` as a
#                                         member of the @pdfcora organisation)
#
# Each package is packed from a copy whose `file:` dependencies on sibling packages
# name the released version instead, since no one installing from the registry has
# the sibling folders.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/npm"
# Dependency order: each package is published after the ones it names.
PACKAGES=(web web-ai node mcp)

rm -rf "$OUT"
mkdir -p "$OUT"

for pkg in "${PACKAGES[@]}"; do
    echo "==> $pkg"
    src="$ROOT/$pkg"
    stage="$OUT/stage/$pkg"
    ( cd "$src" && npm run build ) > "$OUT/$pkg-build.log" 2>&1 \
        || { echo "build failed — see $OUT/$pkg-build.log" >&2; exit 1; }
    mkdir -p "$stage"
    python3 - "$src" "$stage" "$ROOT" <<'EOF'
import json, os, shutil, sys
src, stage, root = sys.argv[1:]
package = json.load(open(os.path.join(src, "package.json")))
for entry in package["files"]:
    path = os.path.join(src, entry)
    (shutil.copytree if os.path.isdir(path) else shutil.copy)(path, os.path.join(stage, entry))
for extra in ("LICENSE.md", "NOTICE.md"):
    shutil.copy(os.path.join(root, extra), stage)
package["files"] += ["LICENSE.md", "NOTICE.md"]
for field in ("dependencies", "peerDependencies"):
    for name, spec in package.get(field, {}).items():
        if spec.startswith("file:"):
            package[field][name] = "^" + package["version"]
# dist is already built and the copy has no node_modules.
package.get("scripts", {}).pop("prepack", None)
json.dump(package, open(os.path.join(stage, "package.json"), "w"), indent=2)
EOF
    ( cd "$stage" && npm pack --pack-destination "$OUT" ) > "$OUT/$pkg-pack.log" 2>&1 \
        || { echo "npm pack failed — see $OUT/$pkg-pack.log" >&2; exit 1; }
done

# What must never ship: TypeScript sources, tests, and anything path-bound to this repo.
python3 - "$OUT" <<'EOF'
import json, os, sys, tarfile
out = sys.argv[1]
problems = []
for name in sorted(os.listdir(out)):
    if not name.endswith(".tgz"):
        continue
    with tarfile.open(os.path.join(out, name)) as tar:
        members = tar.getnames()
        package = json.load(tar.extractfile("package/package.json"))
    for m in members:
        if (m.endswith(".ts") and not m.endswith(".d.ts")) or "/test" in m or "dist-test" in m:
            problems.append(f"{name}: ships {m}")
    for field in ("dependencies", "peerDependencies"):
        for dep, spec in package.get(field, {}).items():
            if spec.startswith(("file:", ".", "/")):
                problems.append(f"{name}: {dep} -> {spec}")
    for required in ("package/LICENSE.md", "package/NOTICE.md"):
        if required not in members:
            problems.append(f"{name}: no {required}")
    size = os.path.getsize(os.path.join(out, name))
    print(f"    {name}  {size / 1e6:.1f} MB  {len(members)} files")
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
EOF

if [ "${1:-}" = "--publish" ]; then
    npm whoami > /dev/null || { echo "not logged in; run npm login" >&2; exit 1; }
    for pkg in "${PACKAGES[@]}"; do
        tarball="$(ls "$OUT"/*.tgz | grep -F "$(python3 -c "import json;print(json.load(open('$ROOT/$pkg/package.json'))['name'].replace('@','').replace('/','-'))")-[0-9]")"
        echo "==> publishing $(basename "$tarball")"
        npm publish "$tarball" --access public
    done
fi
