# AI — Android

Summarise a document with ML Kit's on-device model, and propose redactions a person
accepts. Everything is in `src/main/java/com/pdfcora/samples/ai/MainActivity.kt`.

<!-- repo -->
```bash
./scripts/fetch-vendor.sh          # from the repo root, once: PDFium binaries
cd samples/ai-android && gradle installDebug
```
<!-- /repo -->
<!-- public
```bash
gradle installDebug
```
-->

Summaries need Google AICore, so they run on a device that has it — not on most emulators,
where `availability()` says so instead. AICore also refuses to run while the app is in the
background or the screen is off. Redaction suggestions are patterns, so they work anywhere.

An app with a hosted model passes `PdfAIOptions(provider = …)`; document text reaches a
provider only because the app configured one.
