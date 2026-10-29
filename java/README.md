# PDFCora for Java

The PDF engine behind Chrome, on the JVM, with the same object model and the core error
cases of the iOS, Android and web SDKs.

```kotlin
implementation("com.pdfcora:pdfcora-java:0.1.0")
```

Java 17 or newer. macOS and Linux, on x86-64 and arm64. The engine is a native library
inside the jar — this SDK uses **JNI, not the Foreign Function API**, so it runs on the
JDK most teams already have rather than requiring 22+.

## First render

```java
import com.pdfcora.*;
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
| `open(byte[])`, `open(byte[], String password)` | Opens a PDF or DOCX from memory |
| `open(Path)`, `open(Path, String password)` | Opens a PDF or DOCX from a file |
| `pageCount()` | Pages in the document |
| `page(int index)` | A page reference; the page loads when used |
| `metadata()` | Title, author, subject, keywords, creator, producer — absent entries omitted |
| `permissions()` | The permission flags the document declares |
| `toByteArray()` | The document as bytes (a full save) |
| `writeTo(Path)` | The same, written to a file |
| `exportXfdf()` | Form values and annotations as XFDF (ISO 19444-1) |
| `importXfdf(String)` | Applies XFDF: field values plus ink, note, highlight, underline and strikeout annotations; returns a `PdfXfdfReport` listing what was skipped and why |
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
a subset of the core cases every platform shares; the other platforms add cases of their
own, such as `cancelled` and `engineUnresponsive`.

```java
try (PdfDocument document = PdfDocument.open(bytes)) { … }
catch (PdfError e) {
    if (e.code() == PdfError.Code.PASSWORD_REQUIRED) askForPassword();
}
```

### Redaction

| Member | Description |
| --- | --- |
| `document.redact(List<Target>)` | Removes content and returns a `Report` |
| `Target.Region(pageIndex, rect)` | A rectangle on one page |
| `Target.TextMatches(query)` | Every match of a phrase, across the document |

Content is removed from the saved bytes, not covered: a text object a region only partly
covers is rewritten without the covered characters, in the same font and position, and
annotations the region touches go with their field values. Drawing a black box is the
classic failure — it looks right and the words are still there.

```java
PdfRedaction.Report report = document.redact(List.of(
        new PdfRedaction.Target.TextMatches("anna.schmidt@example.com")));
document.writeTo(Path.of("redacted.pdf"));   // always a full save, which redaction needs
```

### Tagging for accessibility

| Member | Description |
| --- | --- |
| `document.isTagged()` | Whether a structure tree is already there |
| `document.objectCount(pageIndex)` | The drawing objects a block addresses |
| `document.tagContent(List<PdfTagBlock>, title, language)` | Writes the tree, returning a new document |

Blocks are given in reading order with the page objects they cover; anything left out
becomes an artifact, which is what a screen reader skips. The result carries a structure
tree, a parent tree, `/MarkInfo`, `/Lang` and an XMP packet claiming PDF/UA-1 — and
`scripts/test-java.sh` runs **veraPDF** over the output, which is what decides whether
that claim is true.

```java
List<PdfTagBlock> blocks = List.of(
    new PdfTagBlock(0, "H1", List.of(0)),
    new PdfTagBlock(0, "P",  List.of(1, 2)),
    new PdfTagBlock(0, "Figure", List.of(3), "The Berlin office at dusk"));
try (PdfDocument tagged = document.tagContent(blocks, "Quarterly newsletter", "en")) {
    tagged.writeTo(Path.of("tagged.pdf"));
}
```

### Signatures

| Member | Description |
| --- | --- |
| `document.signatures()` | Every signature: reason, sub-filter, time, byte range, contents, `coversWholeDocument` |
| `signature.verify(byte[] document)` | Recomputes the digest over the signed ranges and compares it |

`verify` answers "have the signed bytes changed since signing?", which is the question
that matters for a document arriving from outside. It does **not** build or trust a
certificate chain: that needs a trust store and a policy, which belong to the application.

### Signing

| Member | Description |
| --- | --- |
| `document.sign(PdfSignOptions)` | Signs a full save of the document and returns the bytes |
| `PdfSigning.sign(byte[] base, PdfSignOptions)` | Signs bytes as they are, appending without rewriting |
| `Pkcs12Signer(byte[] pkcs12, String password)` | The signer the SDK ships: JCA, RSA or EC, no Bouncy Castle |
| `CmsSigner` | Implement it to sign with an HSM, a smart card or a remote service |

```java
import com.pdfcora.sign.*;
import java.nio.file.Files;

Pkcs12Signer signer = new Pkcs12Signer(Files.readAllBytes(identity), password);
byte[] signed = document.sign(PdfSignOptions.with(signer)
    .reason("I approve this contract")
    .contactInfo("signer@example.com"));
```

The signature is appended as an incremental update with a fixed-size `/Contents`
placeholder, so the bytes underneath it are never rewritten and the `/ByteRange` keeps
naming what it signed. `document.sign` signs a **full save**, so everything done to the
document in memory is inside the signature — but that save rewrites the file, and a
signature already in it does not survive. To add a second signature, pass the original
bytes to `PdfSigning.sign`, which appends and leaves the first one verifying. This differs
from iOS, Android and the web, where `sign` signs the bytes as they were opened.

`Pkcs12Signer` builds the CMS itself and adds the CAdES `signingCertificateV2` attribute,
so the default `ETSI.CAdES.detached` sub-filter is honest about what the blob contains;
pass `.subFilter("adbe.pkcs7.detached")` for a plain PKCS#7 signer.

RFC 3161 timestamping is not here yet — iOS, Android and web take a `timestampUrl`; on
Java a signature is PAdES B-B rather than B-T.

### The viewer

`com.pdfcora.view.PdfViewer` is the viewer's logic with no user interface: page, zoom,
centre, tool and review marks. Its state is a value, so it can be sent to another device
and adopted there — which is how the iOS, Android and web viewers stay in step.

```java
import com.pdfcora.view.*;
import java.awt.image.BufferedImage;

PdfViewer viewer = PdfViewer.open(document, 800, 1000);
viewer.zoomIn();
viewer.nextPage();
BufferedImage image = viewer.render();          // at the zoomed size, so text stays sharp
follower.apply(viewer.state());                 // a fit is re-derived for the follower's window
```

## Word documents

`open` also accepts a DOCX. The SDK sees from the bytes that it is a Word file, converts
it to PDF inside the process with [docxide-pdf](https://github.com/sverrejb/docxide-pdf),
and from then on the document is that PDF: render, text, search, forms, redaction,
signing and tagging all work as usual, and saving gives a PDF.

```java
try (PdfDocument document = PdfDocument.open(Path.of("letter.docx"))) {
    document.writeTo(Path.of("letter.pdf"));
}
```

- **DOCX only.** Not `.doc`, XLSX, PPTX, ODT or RTF; those fail as `CORRUPT`, as an
  unreadable PDF does.
- **Encrypted DOCX** is refused with `CORRUPT` and the message
  "encrypted DOCX is not supported". A password passed with a DOCX is ignored.
- **Limits.** At most 100 MiB in, and at most 512 MiB unpacked, counted as it unpacks.
  Past either, `open` raises `CORRUPT` with "the DOCX is too large". The conversion runs
  in the JVM process: errors and Rust panics become a `PdfError`, but a hostile file can
  still exhaust memory or the stack, as a hostile PDF can.

### Fonts

The PDF can only look like Word's if the fonts match. The converter uses, in order: fonts
embedded in the DOCX, the folders in the `DOCXIDE_FONTS` environment variable
(colon-separated), then the system font folders — `/Library/Fonts`,
`/System/Library/Fonts` and `~/Library/Fonts` on macOS; `/usr/share/fonts`,
`/usr/local/share/fonts` and `~/.local/share/fonts` on Linux. The SDK ships no fonts.

A Linux server or container usually has few fonts. These packages give metric-compatible
stand-ins for Arial, Times New Roman, Courier New, Calibri and Cambria, and Chinese,
Japanese and Korean text:

```bash
apt-get install fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-cjk
```

The converter keeps an index of the fonts it found in `$XDG_CACHE_HOME/docxide-pdf` or
`~/.cache/docxide-pdf` (`~/Library/Caches/docxide-pdf` on macOS). Conversion works when
that folder cannot be written.

## Threading

The SDK is thread-safe. PDFium's state is global, so every call on every document runs on
one engine thread for the whole process, as on iOS and Android. Calling from several
threads, on one document or several, is safe — the calls serialise; they do not run in
parallel. Tests drive one document from eight threads, and six documents from six threads
at once.

Converting a DOCX happens on the calling thread, before the engine is involved, so several
conversions do run in parallel.

## Building it

The jar carries a native library per platform, built from the vendored engine:

```bash
./scripts/fetch-vendor.sh         # engines into vendor/, checksums verified
./scripts/build-jni.sh            # macOS here, Linux in a container
./scripts/test-java.sh            # the suite, against the shared fixtures
```

`build-jni.sh macos` needs an Xcode whose SDK this PDFium revision understands and Rust
1.92 (the DOCX converter, `src/main/rust`), and `build-jni.sh linux` needs Docker. `-Dpdfcora.native.path=/path/to/lib` overrides the
library the SDK loads, for a build that manages its own.

## What is not here yet

- **RFC 3161 timestamping.** Signing is here; a timestamp would raise it from PAdES B-B
  to B-T, and needs a call to an authority.
- **The AI package** — answers, summaries, redaction and form proposals, alt text,
  remediation, semantic diff. All of it sits above the core.
- **Agent tools** (MCP and WebMCP), which are a Node and browser concern.
- **Windows.** The engine is built for macOS and Linux only.
- **Tagging a document whose objects live in object streams.** Tagging runs on a full
  save, which PDFium writes plainly, so this is not hit in practice — but a file that
  arrives that way is refused with a clear error rather than half-written.

`@pdfcora/node` has the AI package and the agent tools today, because it is the web SDK
rather than a second implementation.
