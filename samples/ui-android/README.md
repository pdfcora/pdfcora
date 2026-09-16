# UI — Android

The viewer component with a hand-picked toolbar, an app accent colour and a save handler.
Everything is in `src/main/java/com/pdfiumkit/samples/ui/MainActivity.kt`.

```bash
./scripts/fetch-vendor.sh          # from the repo root, once: PDFium binaries
cd samples/ui-android && gradle installDebug
```

The SDK comes from this repository through `includeBuild("../../android")`; an app outside
the repo depends on the published artifact instead.

Pages show a "PdfiumKit trial" watermark: the sample runs without a license key. The
commented line in `MainActivity.kt` shows where a key issued for this app goes.
