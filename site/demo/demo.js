import {
  configureEngine, darkTheme, PdfDocument, PdfError, PdfViewerElement,
} from './sdk/index.js';

// In a browser the page says where the engine's WebAssembly lives. Both files ship
// inside the npm package; an app serves them from wherever it likes.
configureEngine({
  factory: async (options) => (await import('./engine/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? './engine/pdfium.esm.wasm' : path),
});

const el = (id) => document.getElementById(id);

let pdf = null;
let name = '';

const status = (text, kind = '') => {
  const box = el('status');
  box.textContent = text;
  box.className = kind;
};

async function open(bytes, from) {
  status(`Opening ${from}…`);
  try {
    if (pdf) await pdf.close();
    pdf = await PdfDocument.open(bytes);
  } catch (error) {
    // Every failure is typed, so a bad file is a message rather than a broken page.
    pdf = null;
    status(error instanceof PdfError ? `${from}: ${error.code} — ${error.message}`
                                     : `${from}: ${error}`, 'bad');
    return;
  }
  name = from;

  const host = el('viewer');
  host.replaceChildren();
  await PdfViewerElement.mount(host, pdf, {
    theme: darkTheme,
    onSave: (saved) => download(saved, name.replace(/\.pdf$/i, '') + '-edited.pdf'),
    // Drawing on the page changes the document, so the panel beside it has gone stale.
    onChange: () => { void describe(); },
  });

  el('query').value = '';
  el('hits').textContent = '';
  el('results').replaceChildren();
  await describe();
  status('');
}

async function describe() {
  const metadata = await pdf.metadata();
  const pages = await pdf.pageCount();
  let fields = 0;
  let annotations = 0;
  for (let i = 0; i < pages; i++) {
    const page = await pdf.page(i);
    fields += (await page.formFields()).length;
    annotations += (await page.annotations()).length;
  }

  const facts = el('facts');
  facts.replaceChildren();
  const fact = (term, value) => facts.insertAdjacentHTML('beforeend',
    `<div><dt>${term}</dt><dd>${value}</dd></div>`);
  fact('File', name);
  fact('Pages', pages);
  fact('Title', metadata.title || '—');
  fact('Producer', metadata.producer || '—');
  fact('Tagged', await pdf.isTagged() ? 'yes' : 'no');
  fact('Form fields', fields);
  fact('Annotations', annotations);
  fact('Signatures', (await pdf.signatures()).length);
}

const escape = (s) => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function search(query) {
  const results = el('results');
  results.replaceChildren();
  if (query.trim().length === 0) { el('hits').textContent = ''; return; }

  let found = 0;
  const pages = await pdf.pageCount();
  for (let i = 0; i < pages; i++) {
    const page = await pdf.page(i);
    const text = await page.text.string();
    for (const hit of await page.text.search(query)) {
      found++;
      if (found > 40) continue;
      const context = text.slice(Math.max(0, hit.start - 30), hit.start + hit.length + 30)
        .replace(/\s+/g, ' ').trim();
      const item = document.createElement('li');
      item.innerHTML = `<b>p${i + 1}</b> ${escape(context)}`;
      results.append(item);
    }
  }
  el('hits').textContent = `${found} match${found === 1 ? '' : 'es'}`
    + (found > 40 ? ', first 40 shown' : '');
}

function download(bytes, as) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = as;
  link.click();
  URL.revokeObjectURL(url);
  status(`Saved ${as} — ${bytes.length} bytes.`);
}

async function loadSample(file) {
  try {
    const response = await fetch(file);
    if (!response.ok) throw new Error(String(response.status));
    await open(new Uint8Array(await response.arrayBuffer()), file);
  } catch (error) {
    status(`Could not load ${file}: ${error.message ?? error}`, 'bad');
  }
}

el('sample').addEventListener('change', (event) => loadSample(event.target.value));

el('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (file) await open(new Uint8Array(await file.arrayBuffer()), file.name);
});

let typing;
el('query').addEventListener('input', (event) => {
  clearTimeout(typing);
  const query = event.target.value;
  typing = setTimeout(() => { if (pdf) search(query); }, 200);
});

status('Starting the engine…');
await loadSample('sample.pdf');
