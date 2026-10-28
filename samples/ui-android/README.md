# UI — Android

The viewer component with a hand-picked toolbar, an app accent colour and a save handler.
Everything is in `src/main/java/com/pdfcora/samples/ui/MainActivity.kt`.

<!-- repo -->
```bash
./scripts/fetch-vendor.sh          # from the repo root, once: PDFium binaries
cd samples/ui-android && gradle installDebug
```
<!-- /repo -->
<!-- public
```bash
gradle installDebug
```
-->

<!-- repo -->
The SDK comes from this repository through `includeBuild("../../android")`; an app outside
the repo depends on the published artifact instead.
<!-- /repo -->
