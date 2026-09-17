# Core — iOS

The core API with no UI component: open a PDF, read its facts, get page text, search, list
form fields, render a page, save. Everything is in `Sources/CoreApp.swift`.

<!-- repo -->
```bash
./scripts/fetch-vendor.sh      # from the repo root, once: PDFium binaries
brew install xcodegen          # once
xcodegen generate && open CoreSample.xcodeproj
```
<!-- /repo -->
<!-- public
```bash
open CoreSample.xcodeproj
```
-->
