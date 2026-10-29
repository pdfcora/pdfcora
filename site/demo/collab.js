import {
  configureEngine, darkTheme, decodeEvent, encodeEvent, PdfDocument, PdfViewerElement,
} from './sdk/index.js';

configureEngine({
  factory: async (options) => (await import('./engine/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? './engine/pdfium.esm.wasm' : path),
});

const el = (id) => document.getElementById(id);
const LATENCY_MS = 120;
const LOG_LIMIT = 40;

let documents = [];

const status = (text, kind = '') => {
  const box = el('status');
  box.textContent = text;
  box.className = kind;
};

function log(from, to, wire) {
  const item = document.createElement('li');
  const who = document.createElement('b');
  who.textContent = `${from} → ${to}`;
  item.append(who, wire);
  const list = el('log');
  list.prepend(item);
  while (list.children.length > LOG_LIMIT) list.lastChild.remove();
}

// One direction of the connection: what one viewer emits, the other replays. A real app
// would put `wire` on a WebSocket here and call `apply` where the message arrives.
function connect(fromName, toName, receiver) {
  return (event) => {
    if (!el('sync').checked) return;
    const wire = encodeEvent(event);
    log(fromName, toName, wire);
    setTimeout(() => {
      receiver.current?.apply(decodeEvent(wire)).catch((error) => status(String(error), 'bad'));
    }, LATENCY_MS);
  };
}

async function load(name) {
  status(`Opening ${name}…`);
  for (const pdf of documents) await pdf.close();
  documents = [];
  el('log').replaceChildren();

  const bytes = new Uint8Array(await (await fetch(name)).arrayBuffer());
  // Two separate documents, as two devices would have; edits carry the file's fingerprint,
  // so each side checks that the other is on the same bytes.
  const alicePdf = await PdfDocument.open(bytes.slice());
  const bobPdf = await PdfDocument.open(bytes.slice());
  documents = [alicePdf, bobPdf];

  const alice = { current: null };
  const bob = { current: null };
  alice.current = await PdfViewerElement.mount(el('left'), alicePdf,
    { theme: darkTheme, onEvent: connect('Alice', 'Bob', bob) });
  bob.current = await PdfViewerElement.mount(el('right'), bobPdf,
    { theme: darkTheme, onEvent: connect('Bob', 'Alice', alice) });
  status('Scroll, zoom, turn pages or draw on either side.');
}

el('sample').onchange = () => { void load(el('sample').value); };
await load(el('sample').value);
