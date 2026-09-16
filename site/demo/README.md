# The hosted web demo

A self-contained copy of the web SDK, so `site/` can be deployed as static files with no
build step and no server. `demo.js` is the whole demo — about 150 lines using
`PdfDocument.open`, `page.render`, `page.text.search` and the document's metadata.

`sdk/` and `engine/` are **copies**, not sources. Refresh them after changing the web SDK:

```bash
(cd web && npm install && npm run build)
rsync -a --exclude='*.map' --exclude='*.d.ts' web/dist/ site/demo/sdk/
cp web/vendor/pdfium.esm.js web/vendor/pdfium.esm.wasm site/demo/engine/
```

The sample documents come from the shared fixtures: `sample.pdf` is
`conformance/fixtures/contract.pdf`, `forms.pdf` is `conformance/forms/forms.pdf`, and
`signed.pdf` is the one the Android demo ships.
