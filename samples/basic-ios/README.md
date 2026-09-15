# Basic viewer — iOS

The smallest iOS integration: open a bundled PDF in `PdfViewerView` with its default
toolbar. Everything is in `Sources/BasicViewerApp.swift`.

The Xcode project is generated, and uses the SDK as a local Swift package from the repo
root:

```bash
brew install xcodegen              # once
xcodegen generate
open BasicViewer.xcodeproj
```

The PDFium binary must be in `vendor/` first (`./scripts/fetch-vendor.sh` from the repo root).
