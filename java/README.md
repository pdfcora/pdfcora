# PdfiumKit for Java

The PDF engine behind Chrome, on the JVM, with the same object model and the same error
cases as the iOS, Android and web SDKs.

```kotlin
implementation("com.pdfiumkit:pdfiumkit:0.1.0")
```

Java 17 or newer. macOS and Linux, on x86-64 and arm64. The engine is a native library
inside the jar — this SDK uses **JNI, not the Foreign Function API**, so it runs on the
JDK most teams already have rather than requiring 22+.

## First render

```java
import com.pdfiumkit.*;
import java.nio.file.Path;
import javax.imageio.ImageIO;

try (PdfDocument document = PdfDocument.open(Path.of("contract.pdf"))) {
    PdfPage page = document.page(0);

    ImageIO.write(page.render(1200), "PNG", Path.of("page-1.png").toFile());

    System.out.println(page.text());
    for (PdfPage.Match match : page.search("invoice")) {
        System.out.println("match at " + match.start() + " for " + match.length());
    }
}
```

## API

### `PdfDocument`

| Member | Description |
| --- | --- |
| `open(byte[])`, `open(byte[], String password)` | Opens from memory |
| `open(Path)`, `open(Path, String password)` | Opens from a file |
| `pageCount()` | Pages in the document |
| `page(int index)` | A page reference; the page loads when used |
| `metadata()` | Title, author, subject, keywords, creator, producer — absent entries omitted |
| `permissions()` | The permission flags the document declares |
| `toByteArray()` | The document as bytes (a full save) |
| `writeTo(Path)` | The same, written to a file |
| `isClosed()`, `close()` | Releases native memory; closing twice is harmless |

`PdfDocument` is `AutoCloseable`, so try-with-resources is the intended shape.

### `PdfPage`

| Member | Description |
| --- | --- |
| `index()` | Its position in the document |
| `size()` | `Size(width, height)` in PDF points |
| `render(int width)` | A `BufferedImage`; the height follows the page's aspect ratio |
| `render(int width, int height, boolean withAnnotations)` | An exact pixel size; annotations and filled fields are drawn |
| `text()` | The page's text in reading order |
| `characterCount()` | How many characters that text has |
| `search(String)`, `search(String, boolean caseSensitive)` | `Match(start, length)` offsets into `text()` |

### Annotations

| Member | Description |
| --- | --- |
| `annotations()` | Every annotation, in document order, as `PdfAnnotation(index, kind, rect, contents)` |
| `addInk(List<List<Point>>)`, `addInk(…, red, green, blue, lineWidth)` | Freehand strokes; returns the new index |
| `addHighlight(List<Quad>)`, `addUnderline(…)`, `addStrikeout(…)` | Text markup over quads |
| `addMarkup(Kind, List<Quad>, red, green, blue, alpha)` | Markup with an explicit colour |
| `addNote(float x, float y, String contents)` | A sticky note |
| `removeAnnotation(int index)` | Removes one; later annotations shift down |

`PdfAnnotation.Kind` covers PDFium's subtypes and keeps `UNKNOWN` for anything not
modelled, so nothing is silently dropped. `Quad.of(rect)` makes the common rectangle case.

```java
PdfPage page = document.page(0);
page.addHighlight(List.of(new PdfPage.Quad(72, 720, 300, 720, 72, 700, 300, 700)));
page.addNote(100, 500, "Check clause 4.2");
document.writeTo(Path.of("annotated.pdf"));
```

### Form fields

| Member | Description |
| --- | --- |
| `formFields()` | `PdfFormField(index, kind, name, value, checked, readOnly, rect)` per widget |
| `setFieldText(int index, String value)` | Sets a text field |
| `setFieldChecked(int index, boolean checked)` | Checks or unchecks a checkbox or radio button |

Values go through PDFium's form-fill environment, so `/V` and `/AS` are written as names
and the appearance is regenerated — a field set any other way reads back correctly here
and shows as empty in other viewers.

```java
for (PdfFormField field : page.formFields()) {
    if (field.kind() == PdfFormField.Kind.TEXT_FIELD) page.setFieldText(field.index(), "Jane Doe");
    if (field.isToggle()) page.setFieldChecked(field.index(), true);
}
```

### `PdfError`

One exception, with the case in `code()`: `PASSWORD_REQUIRED`, `WRONG_PASSWORD`,
`CORRUPT`, `PAGE_OUT_OF_RANGE`, `CLOSED`, `INVALID_OPERATION`, `SAVE_FAILED`. These are
the same cases the other platforms raise, so error handling ports unchanged.

```java
try (PdfDocument document = PdfDocument.open(bytes)) { … }
catch (PdfError e) {
    if (e.code() == PdfError.Code.PASSWORD_REQUIRED) askForPassword();
}
```

## Threading

PDFium is not thread-safe. Every document owns one thread and every call runs on it, so
calling from several threads is safe — the calls serialise rather than corrupting memory.
This mirrors the actor on iOS and the single-threaded dispatcher on Android. A test drives
one document from eight threads and asserts they all read the same text.

Separate documents are independent, so throughput comes from opening several.

## Building it

The jar carries a native library per platform, built from the vendored engine:

```bash
./scripts/fetch-vendor.sh         # engines into vendor/, checksums verified
./scripts/build-jni.sh            # macOS here, Linux in a container
./scripts/test-java.sh            # the suite, against the shared fixtures
```

`build-jni.sh macos` needs an Xcode whose SDK this PDFium revision understands, and
`build-jni.sh linux` needs Docker. `-Dpdfiumkit.native.path=/path/to/lib` overrides the
library the SDK loads, for a build that manages its own.

## What is not here yet

Present: open, pages, render, text, search, metadata, save, annotations and form filling.

Not yet, and each needs work beyond binding an engine call — the other SDKs implement
these above PDFium, so Java needs the same logic written again:

- **Signatures.** Reading and verifying needs CMS parsing; signing needs incremental
  writing too. BouncyCastle would do the cryptography.
- **Redaction.** Removing content from the saved bytes, including rewriting text objects
  that are only partly covered.
- **Tagging for accessibility.** A structure tree, parent tree and XMP packet, written by
  a byte-level PDF writer.
- **Viewer state.** Page, zoom, scroll and tools as portable values.
- **The AI package.** Answers, summaries, proposals; all of it sits above the core.

Everything on that list exists on iOS, Android and the web today. If you need it on a
server now, `@pdfiumkit/node` has all of it, because it is the web SDK rather than a
second implementation.
