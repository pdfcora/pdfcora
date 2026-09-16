# @pdfiumkit/node

PdfiumKit for Node, Deno and Bun — the same PDF SDK as the browser package, with the
things a server needs and a browser does not.

```bash
npm install @pdfiumkit/node
```

Requires Node 18 or newer. The engine is WebAssembly and ships inside the package, so
there is nothing to compile and no native module to match to your platform.

## What it adds

`@pdfiumkit/node` re-exports **everything** from `@pdfiumkit/web` — same classes, same
methods, same errors — and adds five functions. Code moves between the two unchanged; a
test asserts that every web export is present here.

| Function | What it does |
| --- | --- |
| `openFile(path, password?)` | Opens a PDF from disk |
| `saveFile(document, path, mode?)` | Writes the document out; `mode` is `'full'` (default) or `'incremental'` |
| `renderPng(page, options?)` | Renders a page and encodes it as PNG |
| `renderRaw(page, options?)` | The raw RGBA, for callers that encode it themselves |
| `useLicenseFromEnvironment(variable?)` | Applies `PDFIUMKIT_LICENSE_KEY`, or the variable you name |

## First render

```ts
import { openFile, renderPng, saveFile } from '@pdfiumkit/node';
import { writeFile } from 'node:fs/promises';

const document = await openFile('contract.pdf');
const page = await document.page(0);

await writeFile('page-1.png', await renderPng(page, { width: 1200 }));

const hits = await page.text.search('invoice');
console.log(`${hits.length} matches, ${await document.pageCount()} pages`);

await document.close();
```

## Everything else

The rest of the API is the web one, documented in that package's README: text extraction
and per-character boxes, search, form fields, annotations, signatures, redaction, the
structure tree and tagging, page operations and saving.

```ts
import { PdfDocument, PdfLicense } from '@pdfiumkit/node';

await PdfLicense.setKey('pk1.…');        // or useLicenseFromEnvironment()
const document = await PdfDocument.open(bytes);
```

## Things to know on a server

**A stalled page cannot be cancelled.** A malformed page can stall inside the engine where
no cancellation reaches. In a browser `PdfWorker` contains that; under Node, run untrusted
documents in a `worker_thread` or a child process you can terminate.

**Memory is the document's.** `close()` releases it. Use `try`/`finally`, or
`await using` where your runtime supports explicit resource management.

**Concurrency.** Each document serialises its own calls, so sharing one across requests is
safe. Separate documents are independent and run in parallel.

**Licensing.** Without a key everything works and output carries a "PdfiumKit trial"
watermark. `PdfLicense.status` says whether a key is valid and which modules it covers.
