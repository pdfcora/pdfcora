import { configureEngine, PdfDocument, PdfError } from './sdk/index.js';

// In a browser the page says where the engine's WebAssembly lives. Both files ship
// inside the npm package; an app serves them from wherever it likes.
configureEngine({
  factory: async (options) => (await import('./engine/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? './engine/pdfium.esm.wasm' : path),
});

const el = (id) => document.getElementById(id);
const canvas = el('page');
const context = canvas.getContext('2d');

let pdf = null;
let pageIndex = 0;
let scale = 1;
let matches = [];

const status = (text, kind = '') => {
  const box = el('status');
  box.textContent = text;
  box.className = kind;
};

async function open(bytes, name) {
  try {
    if (pdf) await pdf.close();
    pdf = await PdfDocument.open(bytes);
  } catch (error) {
    // Every failure is typed, so a bad file is a message rather than a broken page.
    pdf = null;
    status(error instanceof PdfError
      ? `${name}: ${error.code} — ${error.message}`
      : `${name}: ${error}`, 'bad');
    return;
  }

  pageIndex = 0;
  matches = [];
  el('viewer').hidden = false;
  el('query').value = '';
  await describe(name);
  await render();
}

async function describe(name) {
  const metadata = await pdf.metadata();
  const count = await pdf.pageCount();
  let fields = 0;
  for (let i = 0; i < count; i++) fields += (await (await pdf.page(i)).formFields()).length;

  el('facts').innerHTML = '';
  const fact = (term, value) => {
    el('facts').insertAdjacentHTML('beforeend',
      `<div><dt>${term}</dt><dd>${value}</dd></div>`);
  };
  fact('File', name);
  fact('Pages', count);
  fact('Title', metadata.title || '—');
  fact('Producer', metadata.producer || '—');
  fact('Tagged', await pdf.isTagged() ? 'yes' : 'no');
  fact('Form fields', fields);
  fact('Signatures', (await pdf.signatures()).length);
  status(`Opened ${name}.`);
}

async function render() {
  const page = await pdf.page(pageIndex);
  const size = await page.size();
  const width = Math.round(Math.min(900, canvas.parentElement.clientWidth - 2) * scale);

  const image = await page.render({ width });
  canvas.width = image.width;
  canvas.height = image.height;
  context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

  // Search results come back in PDF space, origin bottom-left; the canvas is
  // top-left, so the only conversion needed is the flip.
  const factor = image.width / size.width;
  context.strokeStyle = '#f5b301';
  context.fillStyle = 'rgba(245, 179, 1, .22)';
  context.lineWidth = 1;
  for (const rect of matches.filter((m) => m.pageIndex === pageIndex)) {
    const x = rect.left * factor;
    const y = (size.height - rect.top) * factor;
    const w = (rect.right - rect.left) * factor;
    const h = (rect.top - rect.bottom) * factor;
    context.fillRect(x, y, w, h);
    context.strokeRect(x, y, w, h);
  }

  el('where').textContent = `Page ${pageIndex + 1} of ${await pdf.pageCount()}`;
  el('dims').textContent = `${Math.round(size.width)} × ${Math.round(size.height)} pt`;
}

async function search(query) {
  matches = [];
  if (query.trim().length > 0) {
    const count = await pdf.pageCount();
    for (let i = 0; i < count; i++) {
      const page = await pdf.page(i);
      // A match carries its own rectangles, one per line it spans.
      for (const hit of await page.text.search(query)) {
        for (const rect of hit.rects) matches.push({ pageIndex: i, ...rect });
      }
    }
  }
  el('hits').textContent = query.trim() === '' ? ''
    : `${matches.length} match${matches.length === 1 ? '' : 'es'}`;
  if (matches.length > 0 && !matches.some((m) => m.pageIndex === pageIndex)) {
    pageIndex = matches[0].pageIndex;
  }
  await render();
}

el('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  status(`Opening ${file.name}…`);
  await open(new Uint8Array(await file.arrayBuffer()), file.name);
});

el('prev').addEventListener('click', async () => {
  if (pageIndex > 0) { pageIndex--; await render(); }
});
el('next').addEventListener('click', async () => {
  if (pageIndex < await pdf.pageCount() - 1) { pageIndex++; await render(); }
});
el('zoomIn').addEventListener('click', async () => {
  scale = Math.min(3, scale * 1.25); await render();
});
el('zoomOut').addEventListener('click', async () => {
  scale = Math.max(0.5, scale / 1.25); await render();
});

let typing;
el('query').addEventListener('input', (event) => {
  clearTimeout(typing);
  const query = event.target.value;
  typing = setTimeout(() => search(query), 200);
});

async function loadSample(name) {
  status(`Loading ${name}…`);
  try {
    const response = await fetch(name);
    await open(new Uint8Array(await response.arrayBuffer()), name);
  } catch (error) {
    status(`Could not load ${name}: ${error}`, 'bad');
  }
}

el('sample').addEventListener('change', (event) => loadSample(event.target.value));

status('Loading the engine…');
await loadSample('sample.pdf');
