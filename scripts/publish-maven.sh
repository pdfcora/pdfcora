#!/usr/bin/env bash
# Builds the Maven Central bundle for the Android and Java SDKs, and optionally uploads it.
#
#   ./scripts/publish-maven.sh              build build/central/bundle.zip and validate it
#   ./scripts/publish-maven.sh --upload     also upload it to the Central Portal
#
# Needs:
#   PDFCORA_SIGNING_KEY, PDFCORA_SIGNING_PASSWORD   the PGP key the bundle is signed with
#   PDFCORA_CENTRAL_TOKEN                           for --upload: base64 of "<user>:<password>"
#                                                   of a Central Portal user token
#
# The upload is USER_MANAGED: Central validates it, and nothing is released until
# "Publish" is pressed at https://central.sonatype.com/publishing/deployments.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/central"
REPO="$OUT/repo"

[ -n "${PDFCORA_SIGNING_KEY:-}" ] || { echo "PDFCORA_SIGNING_KEY is not set; Central rejects unsigned files" >&2; exit 1; }
[ -d "$ROOT/java/src/main/resources/native" ] || { echo "no native engine for Java; run ./scripts/build-jni.sh" >&2; exit 1; }
if [ "${1:-}" = "--upload" ]; then
    [ -n "${PDFCORA_CENTRAL_TOKEN:-}" ] || { echo "PDFCORA_CENTRAL_TOKEN is not set" >&2; exit 1; }
fi

rm -rf "$OUT"
mkdir -p "$REPO"

echo "==> Android"
( cd "$ROOT/android" && gradle --console=plain -PdistRepo="$REPO" \
    :pdfcora:publishReleasePublicationToDistRepository \
    :pdfcora-ui:publishReleasePublicationToDistRepository \
    :pdfcora-ai:publishReleasePublicationToDistRepository ) > "$OUT/android.log" 2>&1 \
    || { echo "gradle failed — see $OUT/android.log" >&2; exit 1; }

echo "==> Java"
( cd "$ROOT/java" && gradle --console=plain -PdistRepo="$REPO" \
    publishMavenPublicationToDistRepository ) > "$OUT/java.log" 2>&1 \
    || { echo "gradle failed — see $OUT/java.log" >&2; exit 1; }

# The checks Central applies, run here so a bad bundle fails before it is uploaded.
python3 - "$REPO" <<'EOF'
import os, re, sys
repo = sys.argv[1]
problems = []
for dirpath, _, files in os.walk(repo):
    poms = [f for f in files if f.endswith(".pom")]
    if not poms:
        continue
    names = set(files)
    base = poms[0][:-4]
    for suffix in ("-sources.jar", "-javadoc.jar"):
        if base + suffix not in names:
            problems.append(f"{base}: no {suffix}")
    for f in files:
        if f.endswith((".asc", ".md5", ".sha1", ".sha256", ".sha512")) or f.startswith("maven-metadata"):
            continue
        for ext in (".asc", ".md5", ".sha1"):
            if f + ext not in names:
                problems.append(f"{f}: no {ext}")
    pom = open(os.path.join(dirpath, poms[0])).read()
    for tag in ("name", "description", "url", "license", "developer", "scm"):
        if f"<{tag}>" not in pom:
            problems.append(f"{poms[0]}: no <{tag}>")
    print("   ", os.path.relpath(dirpath, repo))
if problems:
    print("\n".join(problems), file=sys.stderr)
    sys.exit(1)
EOF

# Central wants the repository layout without Gradle's maven-metadata files.
( cd "$REPO" && find . -name 'maven-metadata*' -delete && zip -qr "$OUT/bundle.zip" com )
echo "bundle: $OUT/bundle.zip ($(du -h "$OUT/bundle.zip" | cut -f1))"

if [ "${1:-}" = "--upload" ]; then
    echo "==> Uploading"
    curl --fail-with-body -sS -X POST \
        -H "Authorization: Bearer $PDFCORA_CENTRAL_TOKEN" \
        -F "bundle=@$OUT/bundle.zip" \
        "https://central.sonatype.com/api/v1/publisher/upload?name=pdfcora-$(date +%Y%m%d-%H%M)&publishingType=USER_MANAGED"
    echo
    echo "uploaded; review and publish at https://central.sonatype.com/publishing/deployments"
fi
