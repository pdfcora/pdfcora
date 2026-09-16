# Core — Android

The core API with no UI component: open a PDF, read its facts, get page text, search, list
form fields, render a page, save. Everything is in
`src/main/java/com/pdfiumkit/samples/core/MainActivity.kt`.

```bash
./scripts/fetch-vendor.sh          # from the repo root, once: PDFium binaries
cd samples/core-android && gradle installDebug
```

The SDK comes from this repository through `includeBuild("../../android")`; an app outside
the repo depends on the published artifact instead.
