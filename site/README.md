# The website

Static files: no build step for the pages themselves. Serve this folder over http — the
live demo and the iOS API references do not work from `file://`.

```bash
cd site && python3 -m http.server 8000     # http://localhost:8000/index.html
```

## Before deploying: the API references

`developers.html` links to an API reference for every package, under `api/`. Those are
generated, not committed — 49 MB that would change with every API change — so build them
first:

```bash
./scripts/fetch-vendor.sh
(cd web && npm install) && (cd web-ai && npm install) && (cd node && npm install)
./scripts/make-docs.sh --site              # writes site/api/
```

`--site` also sets the URL path DocC bakes into the iOS references to `/api`. If the site
is served under a sub-path — `https://example.com/pdfcora/` — set it to match, or every
iOS reference page will load its own "page not found":

```bash
PDFCORA_DOCS_BASE=/pdfcora/api ./scripts/make-docs.sh --site
```

It builds ten references: the core, viewer and AI modules on iOS and on Android, the web
core and web AI packages, Node, and Java.

## The live demo

`demo/` carries a copy of the built web SDK so it runs with no build step. Refresh the
copy after changing the web SDK — see `demo/README.md`.

## Deploying

Cloudflare Pages, two projects:

| Project | Address | Who can see it |
| --- | --- | --- |
| `pdfcora-preview` | https://pdfcora-preview.pages.dev | anyone with the preview password |
| `pdfcora` | https://pdfcora.pages.dev, then pdfcora.com | everyone |

```bash
npx wrangler login                         # once per machine
./scripts/make-docs.sh --site              # the API references
./scripts/deploy-site.sh preview           # or: production
```

The preview project runs `deploy/preview/functions/_middleware.js`, which asks for a
password on every request and serves nothing if none is configured. The public project
deploys from `deploy/production`, which has no functions, so the gate can never reach it.
The password is a secret on the preview project; to change it:

```bash
npx wrangler pages secret put PREVIEW_PASSWORD --project-name pdfcora-preview
```

The site has a top-level `404.html` on purpose: without one, Pages treats the site as a
single-page app and answers every missing URL with the home page and a 200.

