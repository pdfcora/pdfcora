# DOCX — Java

Opens a Word file (`sample.docx`) with the same `PdfDocument.open` call as a PDF. The SDK
converts it to PDF on open; after that it is an ordinary document: page text, render a
page to a PNG, save. Everything is in `src/main/java/Main.java`.

<!-- repo -->
```bash
(cd ../.. && ./scripts/fetch-vendor.sh && ./scripts/build-jni.sh)   # the native engine
gradle run
```
<!-- /repo -->
<!-- public
```bash
gradle run
```
-->

Saving gives a PDF, not a DOCX. Only DOCX is read: not `.doc`, XLSX or PPTX. The result
looks best when the fonts the document names are installed; see
["Word documents"](https://github.com/pdfcora/pdfcora/blob/master/java/README.md#word-documents)
in the Java SDK README.
