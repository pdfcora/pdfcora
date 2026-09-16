# AI — iOS

Summarise a document with Apple's on-device model, and propose redactions a person
accepts. Everything is in `Sources/AIApp.swift`.

```bash
./scripts/fetch-vendor.sh      # from the repo root, once: PDFium binaries
brew install xcodegen          # once
xcodegen generate && open AISample.xcodeproj
```

Summaries need Apple Intelligence, so `availability()` says what a device without it
reports; redaction suggestions are patterns, so they work anywhere. An app with a hosted
model passes `PdfiumAIOptions(provider: …)` instead.
