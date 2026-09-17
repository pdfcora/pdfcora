#!/usr/bin/env bash
# Deploys the website to Cloudflare Pages.
#
#   ./scripts/deploy-site.sh preview       private, password-protected: pdfcora-preview.pages.dev
#   ./scripts/deploy-site.sh production    public: pdfcora.pages.dev (and pdfcora.com once attached)
#
# Needs `npx wrangler login` once on this machine, and site/api built first with
# `./scripts/make-docs.sh --site`. The preview password is a Pages secret on the
# preview project:
#
#   npx wrangler pages secret put PREVIEW_PASSWORD --project-name pdfcora-preview
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-preview}"
case "$TARGET" in
  preview)    PROJECT=pdfcora-preview; FROM=deploy/preview ;;
  production) PROJECT=pdfcora;         FROM=deploy/production ;;
  *) echo "usage: $0 preview|production" >&2; exit 1 ;;
esac

[ -f site/api/index.html ] || { echo "site/api is missing; run ./scripts/make-docs.sh --site first" >&2; exit 1; }

# A clean copy: developer notes and the local serve helper are not part of the site.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude 'README.md' --exclude 'serve.sh' --exclude '.DS_Store' --exclude '.work' site/ "$STAGE/"
echo "==> $TARGET: $(find "$STAGE" -type f | wc -l | tr -d ' ') files, $(du -sh "$STAGE" | cut -f1)"

# Wrangler looks for Pages Functions in ./functions of the directory it runs in, so the
# preview deploys from deploy/preview (which has the password gate) and production from
# deploy/production (which has none).
mkdir -p "$FROM"
cd "$FROM"
npx --yes wrangler@4 pages deploy "$STAGE" --project-name "$PROJECT" --branch main --commit-dirty=true
