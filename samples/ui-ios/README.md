# UI — iOS

The viewer component with a hand-picked toolbar, an app accent colour and a save handler.
Everything is in `Sources/ViewerApp.swift`.

<!-- repo -->
```bash
./scripts/fetch-vendor.sh      # from the repo root, once: PDFium binaries
brew install xcodegen          # once
xcodegen generate && open ViewerUI.xcodeproj
```
<!-- /repo -->
<!-- public
```bash
open ViewerUI.xcodeproj
```
-->

`PdfToolbarConfiguration.default` and `.viewing` are ready-made; this sample lists its own
items. The viewer never writes a file — `onSave` hands the app the bytes.
