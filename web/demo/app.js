import { PdfDocument, PdfError, configureEngine, toViewRect } from '../dist/src/index.js';

// The browser supplies the Emscripten factory; Node's default loader does not apply here.
configureEngine({
  factory: async (options) => {
    if (!window.PDFiumModule) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '../../vendor/web/pdfium.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('failed to load pdfium.js'));
        document.head.appendChild(script);
      });
    }
    return window.PDFiumModule(options);
  },
  locateFile: (path) => (path.endsWith('.wasm') ? '../../vendor/web/pdfium.wasm' : path),
});

const state = { document: null, pageCount: 0, pageIndex: 0, tab: 'viewer' };

const TABS = [
  ['viewer', 'Viewer', renderViewer],
  ['search', 'Search', renderSearch],
  ['outline', 'Outline', renderOutline],
  ['thumbnails', 'Thumbnails', renderThumbnails],
  ['annotations', 'Annotations', renderAnnotations],
  ['forms', 'Forms', renderForms],
  ['text', 'Text', renderText],
  ['info', 'Document Info', renderInfo],
  ['pageops', 'Page Operations', renderPageOps],
  ['export', 'Export', renderExport],
];

const $panel = document.getElementById('panel');
const $status = document.getElementById('status');

function setStatus(message, isError = false) {
  $status.textContent = message;
  $status.className = isError ? 'error' : '';
}

function buildTabs() {
  const nav = document.getElementById('tabs');
  nav.replaceChildren(...TABS.map(([id, label]) => {
    const button = document.createElement('button');
    button.textContent = label;
    button.setAttribute('aria-selected', String(state.tab === id));
    button.onclick = () => { state.tab = id; buildTabs(); draw(); };
    return button;
  }));
}

async function load(bytes, title) {
  try {
    const opened = await PdfDocument.open(bytes);
    if (state.document) await state.document.close();
    state.document = opened;
    state.pageCount = await opened.pageCount();
    state.pageIndex = 0;
    setStatus(`${title} — ${state.pageCount} page${state.pageCount === 1 ? '' : 's'}`);
    draw();
  } catch (error) {
    setStatus(error instanceof PdfError ? error.message : String(error), true);
  }
}

async function loadSample(name) {
  const response = await fetch(`../../conformance/corpus/${name}`);
  if (!response.ok) {
    setStatus(`could not fetch ${name} (${response.status})`, true);
    return;
  }
  await load(new Uint8Array(await response.arrayBuffer()), name);
}

function draw() {
  const entry = TABS.find(([id]) => id === state.tab);
  $panel.replaceChildren();
  if (!state.document) {
    $panel.append(el('p', { className: 'muted' }, 'No document loaded.'));
    return;
  }
  entry[2]().catch((error) => {
    $panel.append(el('p', { className: 'error' }, String(error?.message ?? error)));
  });
}

// MARK: - Helpers

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

async function canvasFor(page, width) {
  const image = await page.render({ width });
  const canvas = el('canvas', { width: image.width, height: image.height });
  canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}

function table(rows) {
  return el('table', {}, ...rows.map(([label, value]) =>
    el('tr', {}, el('th', {}, label), el('td', {}, String(value)))));
}

// MARK: - Screens

async function renderViewer() {
  const page = await state.document.page(state.pageIndex);
  const controls = el('div', { className: 'row' },
    button('Previous', () => { state.pageIndex--; draw(); }, state.pageIndex === 0),
    el('span', { className: 'muted' }, `Page ${state.pageIndex + 1} of ${state.pageCount}`),
    button('Next', () => { state.pageIndex++; draw(); }, state.pageIndex >= state.pageCount - 1),
  );
  $panel.append(controls, await canvasFor(page, 900));
}

function button(label, onclick, disabled = false) {
  return el('button', { textContent: label, onclick, disabled });
}

async function renderSearch() {
  const input = el('input', { type: 'text', placeholder: 'Search the document' });
  const caseBox = el('input', { type: 'checkbox', id: 'cs' });
  const results = el('div');

  const run = async () => {
    results.replaceChildren(el('p', { className: 'muted' }, 'Searching…'));
    const hits = [];
    for (let i = 0; i < state.pageCount; i++) {
      const page = await state.document.page(i);
      for (const match of await page.text.search(input.value, { caseSensitive: caseBox.checked })) {
        hits.push([i, match]);
      }
    }
    results.replaceChildren(
      hits.length
        ? table(hits.map(([page, match]) =>
            [`Page ${page + 1}`, `characters ${match.start}–${match.start + match.length}, ${match.rects.length} rect(s)`]))
        : el('p', { className: 'muted' }, `No matches for “${input.value}”.`),
    );
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') run(); };

  $panel.append(
    el('div', { className: 'row' }, input, caseBox, el('label', { htmlFor: 'cs' }, 'Case sensitive'),
       button('Find', run)),
    results,
  );
}

async function renderOutline() {
  const outline = await state.document.outline();
  if (outline.length === 0) {
    $panel.append(el('p', { className: 'muted' }, 'This document has no outline.'));
    return;
  }
  const rows = [];
  const walk = (items, depth) => {
    for (const item of items) {
      rows.push([`${'\u00a0'.repeat(depth * 4)}${item.title || '(untitled)'}`,
                 item.pageIndex != null ? `p.${item.pageIndex + 1}` : '']);
      walk(item.children, depth + 1);
    }
  };
  walk(outline, 0);
  $panel.append(table(rows));
}

async function renderThumbnails() {
  const grid = el('div', { className: 'grid' });
  $panel.append(grid);
  for (let i = 0; i < state.pageCount; i++) {
    const page = await state.document.page(i);
    grid.append(el('figure', {}, await canvasFor(page, 150), el('figcaption', {}, String(i + 1))));
  }
}

async function renderAnnotations() {
  const page = await state.document.page(0);
  const annotations = await page.annotations();

  const refresh = async (action) => { await action(); draw(); };
  $panel.append(
    el('div', { className: 'row' },
      button('Add ink', () => refresh(() => page.addInk(
        Array.from({ length: 21 }, (_, i) => {
          const t = i / 20;
          return { x: 40 + t * 120, y: 90 + Math.sin(t * Math.PI * 2) * 25 };
        }), { red: 0, green: 90, blue: 220 }))),
      button('Add note', () => refresh(() =>
        page.addNote({ left: 30, bottom: 30, right: 60, top: 60 }, 'Added from the demo'))),
      button('Remove last', () => refresh(() => page.removeAnnotation(annotations.length - 1)),
             annotations.length === 0),
    ),
    await canvasFor(page, 700),
    el('p', {}, `${annotations.length} annotation(s) on page 1`),
    table(annotations.map((a) => [describe(a), a.contents ?? ''])),
  );
}

/** Exhaustive over the discriminated union — a new kind shows up here immediately. */
function describe(annotation) {
  switch (annotation.kind) {
    case 'highlight': case 'underline': case 'strikeout': case 'squiggly':
      return `${annotation.kind} (${annotation.quads.length} quads)`;
    case 'ink': return `ink (${annotation.strokes.length} strokes)`;
    case 'link': return `link ${annotation.uri ?? ''}`;
    case 'widget': return `widget ${annotation.fieldName ?? ''}`;
    case 'unknown': return `unknown (subtype ${annotation.subtypeCode})`;
    default: return annotation.kind;
  }
}

async function renderForms() {
  const page = await state.document.page(0);
  const fields = await page.formFields();
  if (fields.length === 0) {
    $panel.append(el('p', { className: 'muted' }, 'This document has no interactive form fields.'));
    return;
  }

  const rows = el('table');
  for (const field of fields) {
    const name = field.name ?? field.alternateName ?? `field ${field.annotationIndex}`;
    let control;

    // Each field kind gets the control that suits it — the point of the union.
    switch (field.kind) {
      case 'text': {
        const input = el('input', { type: 'text', value: field.value });
        control = el('span', {}, input, button('Set', async () => {
          await page.setText(input.value, field.annotationIndex);
          draw();
        }));
        break;
      }
      case 'checkBox': case 'radioButton': {
        const box = el('input', { type: 'checkbox', checked: field.isChecked });
        box.onchange = async () => { await page.setChecked(box.checked, field.annotationIndex); draw(); };
        control = box;
        break;
      }
      case 'comboBox': case 'listBox': {
        const select = el('select', {}, ...field.options.map((option, i) =>
          el('option', { value: String(i), textContent: option || '(blank)',
                         selected: field.selectedIndices.includes(i) })));
        select.onchange = async () => {
          await page.setOption(Number(select.value), true, field.annotationIndex);
          draw();
        };
        control = select;
        break;
      }
      default:
        control = el('span', { className: 'muted' }, field.kind);
    }
    rows.append(el('tr', {}, el('th', {}, name), el('td', {}, control)));
  }
  $panel.append(rows, await canvasFor(page, 600));
}

async function renderText() {
  const page = await state.document.page(state.pageIndex);
  const text = await page.text.string();
  const count = await page.text.characterCount();

  $panel.append(
    el('div', { className: 'row' },
      button('Previous', () => { state.pageIndex--; draw(); }, state.pageIndex === 0),
      el('span', { className: 'muted' }, `Page ${state.pageIndex + 1} — ${count} chars`),
      button('Next', () => { state.pageIndex++; draw(); }, state.pageIndex >= state.pageCount - 1),
      button('Copy', () => navigator.clipboard?.writeText(text), !text),
    ),
    el('pre', {}, text || 'This page has no extractable text.'),
  );
}

async function renderInfo() {
  const [metadata, permissions, attachments] = await Promise.all([
    state.document.metadata(),
    state.document.permissions(),
    state.document.attachments(),
  ]);
  $panel.append(
    el('h3', {}, 'Engine'),
    table([['PDFium', PdfDocument.engineVersion], ['Pages', state.pageCount]]),
    el('h3', {}, 'Metadata'),
    table([
      ['Title', metadata.title ?? '—'], ['Author', metadata.author ?? '—'],
      ['Subject', metadata.subject ?? '—'], ['Creator', metadata.creator ?? '—'],
      ['Producer', metadata.producer ?? '—'],
    ]),
    el('h3', {}, 'Permissions'),
    table(Object.entries(permissions).map(([k, v]) => [k, v ? '✓' : '✗'])),
    el('h3', {}, 'Attachments'),
    attachments.length
      ? table(attachments.map((a) => [a.name, '']))
      : el('p', { className: 'muted' }, 'None'),
  );
}

async function renderPageOps() {
  const page = await state.document.page(state.pageIndex);
  const size = await page.size();
  const rotation = await state.document.rotation(state.pageIndex);

  const rotate = async (delta) => {
    const next = ((rotation / 90 + delta + 4) % 4) * 90;
    await state.document.setRotation(state.pageIndex, next);
    draw();
  };

  $panel.append(
    el('div', { className: 'row' },
      button('Previous', () => { state.pageIndex--; draw(); }, state.pageIndex === 0),
      button('Rotate ↺', () => rotate(-1)),
      button('Rotate ↻', () => rotate(1)),
      button('Next', () => { state.pageIndex++; draw(); }, state.pageIndex >= state.pageCount - 1),
    ),
    el('p', { className: 'muted' },
       `${size.width.toFixed(0)} × ${size.height.toFixed(0)} pt · rotation ${rotation}°`),
    await canvasFor(page, 600),
  );
}

async function renderExport() {
  const mode = el('select', {},
    el('option', { value: 'full', textContent: 'Full rewrite' }),
    el('option', { value: 'incremental', textContent: 'Incremental' }));
  const note = el('p', { className: 'muted' });
  const update = () => {
    note.textContent = mode.value === 'incremental'
      ? 'Incremental keeps the original bytes and existing signatures, but does not persist annotations created in this session.'
      : 'Full rewrite persists everything, including new annotations.';
  };
  mode.onchange = update;
  update();

  const result = el('p', { className: 'muted' });
  $panel.append(
    el('div', { className: 'row' }, mode, button('Export', async () => {
      try {
        const bytes = await state.document.toBytes(mode.value);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        const link = el('a', { href: url, download: 'pdfiumkit-export.pdf', textContent: 'Download' });
        result.replaceChildren(`Exported ${(bytes.length / 1024).toFixed(0)} KB — `, link);
      } catch (error) {
        result.textContent = `Export failed — ${error.message}`;
        result.className = 'error';
      }
    })),
    note, result,
  );
}

// MARK: - Wiring

document.getElementById('sample').onchange = (e) => loadSample(e.target.value);
document.getElementById('file').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (file) await load(new Uint8Array(await file.arrayBuffer()), file.name);
};

buildTabs();
setStatus('Loading PDFium…');
loadSample('hello_world.pdf');
