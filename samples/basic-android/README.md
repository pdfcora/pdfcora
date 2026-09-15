# Basic viewer — Android

The smallest Android integration: open a bundled PDF in `PdfViewerView` with its default
toolbar. Everything is in `MainActivity.kt`.

The app depends on `com.pdfiumkit:pdfiumkit-ui:0.1.0`. `settings.gradle.kts` includes the
SDK's Gradle build from this repository, so that dependency resolves to the local source.

```bash
gradle installDebug
adb shell am start -n com.pdfiumkit.samples.basicviewer/.MainActivity
```

The PDFium libraries must be in `vendor/` first (`./scripts/fetch-vendor.sh` from the repo
root).
