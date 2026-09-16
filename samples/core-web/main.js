import { configureEngine, PdfDocument } from '../../web/dist/index.js';

// In a browser the page says where PDFium's WASM build lives. These paths point at the
// copy inside the SDK package; an app serves the same two files from wherever it likes.
configureEngine({
  factory: async (options) => (await import('../../web/vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '../../web/vendor/pdfium.esm.wasm' : path),
});

const say = (term, value) => {
  document.getElementById('facts').insertAdjacentHTML(
    'beforeend', `<dt>${term}</dt><dd>${value}</dd>`);
};

const bytes = new Uint8Array(await (await fetch('sample.pdf')).arrayBuffer());
const pdf = await PdfDocument.open(bytes);

// Document facts.
const metadata = await pdf.metadata();
say('Pages', await pdf.pageCount());
say('Title', metadata.title || '(none)');
say('Signatures', (await pdf.signatures()).length);

const page = await pdf.page(0);

// Text, search and form fields all come from the page.
const text = await page.text.string();
document.getElementById('text').textContent = text.slice(0, 600);
say('Matches for "the"', (await page.text.search('the')).length);
say('Form fields on page 1', (await page.formFields()).length);

// Rendering hands back raw RGBA, which a canvas takes as it is.
const image = await page.render({ width: 700 });
const canvas = document.getElementById('page');
canvas.width = image.width;
canvas.height = image.height;
canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

// Saving returns the bytes; an app writes or uploads them.
say('Saved size', `${(await pdf.toBytes()).length} bytes`);
