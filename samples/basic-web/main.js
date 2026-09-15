import { configureEngine, PdfDocument, PdfViewerElement } from '../../web/dist/index.js';

// In a browser the page says where PDFium's WASM build lives. These paths point at the
// copy inside the SDK package; an app serves the same two files from wherever it likes.
configureEngine({
  factory: async (options) => (await import('../../web/vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '../../web/vendor/pdfium.esm.wasm' : path),
});

// Without a license key the SDK works fully, but pages carry a "PdfiumKit trial"
// watermark. With a key issued for this site's hostname, import PdfLicense above and set
// it before opening documents:
// await PdfLicense.setKey('pk1.…');

const bytes = new Uint8Array(await (await fetch('sample.pdf')).arrayBuffer());
const pdf = await PdfDocument.open(bytes);
await PdfViewerElement.mount(document.getElementById('viewer'), pdf);
