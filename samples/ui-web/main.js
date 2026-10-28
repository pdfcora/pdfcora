import {
  configureEngine, PdfDocument, PdfViewerElement, toolbarItems, lightTheme,
} from '../../web/dist/index.js';

// In a browser the page says where PDFium's WASM build lives. These paths point at the
// copy inside the SDK package; an app serves the same two files from wherever it likes.
configureEngine({
  factory: async (options) => (await import('../../web/vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '../../web/vendor/pdfium.esm.wasm' : path),
});

const bytes = new Uint8Array(await (await fetch('sample.pdf')).arrayBuffer());
const pdf = await PdfDocument.open(bytes);

await PdfViewerElement.mount(document.getElementById('viewer'), pdf, {
  // A toolbar is a list of items: drop what the app does not offer, keep the order.
  // `defaultToolbar` and `viewingToolbar` are ready-made; this one is hand-picked.
  toolbar: {
    items: [
      toolbarItems.pageBack, toolbarItems.pageForward, toolbarItems.divider,
      toolbarItems.tool('highlight'), toolbarItems.tool('note'), toolbarItems.divider,
      toolbarItems.zoomOut, toolbarItems.fitWidth, toolbarItems.zoomIn,
      toolbarItems.spacer, toolbarItems.save,
    ],
  },
  // Themes are plain objects; this one is the light theme with the app's accent.
  theme: { ...lightTheme, accent: '#7c3aed' },
  // The viewer never writes a file; it hands the app the bytes it saved.
  onSave: (saved) => {
    document.getElementById('status').textContent =
      `Saved ${saved.length} bytes — an app would upload or download them here.`;
  },
});
