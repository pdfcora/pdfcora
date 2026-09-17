# @pdfcora/web

PDFCora for the browser: open, render, search, fill forms, annotate, redact, tag and sign
PDFs, with a ready-made viewer component. The engine is WebAssembly and ships inside the
package.

```bash
npm install @pdfcora/web
```

Documentation: https://pdfcora.com/developers.html

## Point the SDK at its engine

In a browser, say where the two engine files are served from. They are in the package's
`vendor/` folder; serve them from the same origin as your app.

```js
import { configureEngine } from '@pdfcora/web';

configureEngine({
  factory: async (options) => (await import('/pdfcora/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '/pdfcora/pdfium.esm.wasm' : path),
});
```

Under Node this step is not needed; use [`@pdfcora/node`](https://www.npmjs.com/package/@pdfcora/node).

## Open, read, render, save

```js
import { PdfDocument } from '@pdfcora/web';

const pdf = await PdfDocument.open(bytes);          // a Uint8Array
const page = await pdf.page(0);

const text = await page.text.string();
const hits = await page.text.search('invoice');
const image = await page.render({ width: 1200 });   // RGBA: { width, height, data }

const saved = await pdf.toBytes();
await pdf.close();
```

## The viewer

```js
import { PdfViewerElement, defaultToolbar } from '@pdfcora/web';

await PdfViewerElement.mount(document.getElementById('viewer'), pdf, {
  toolbar: defaultToolbar,
  onSave: (bytes) => upload(bytes),
});
```

## Licensing

Everything works without a key; rendered pages and saved files then carry a
"PDFCora trial" watermark. `await PdfLicense.setKey('pk1.…')` before opening documents
removes it. Keys are checked offline. Terms: see `LICENSE.md`. Third-party licences:
`NOTICE.md`.
