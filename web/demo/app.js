import { PdfDocument, PdfError, PdfViewTransform, rectContains, configureEngine } from '../dist/index.js';
import { PdfiumAI } from '../../web-ai/dist/index.js';

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

const state = {
  document: null, pageCount: 0, pageIndex: 0, tab: 'editor',
  tool: 'select', zoom: null, selected: null, createdCount: 0, aiEndpoint: null,
};

const TABS = [
  ['editor', 'Editor', renderEditor],
  ['viewer', 'Viewer', renderViewer],
  ['search', 'Search', renderSearch],
  ['outline', 'Outline', renderOutline],
  ['thumbnails', 'Thumbnails', renderThumbnails],
  ['annotations', 'Annotations', renderAnnotations],
  ['forms', 'Forms', renderForms],
  ['text', 'Text', renderText],
  ['signatures', 'Signatures', renderSignatures],
  ['info', 'Document Info', renderInfo],
  ['pageops', 'Page Operations', renderPageOps],
  ['export', 'Export', renderExport],
  ['ai', 'AI', renderAI],
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

// MARK: - Editor

const TOOLS = [
  ['select', 'Select', 'Edit fields on the page'],
  ['ink', 'Ink', 'Drag to draw'],
  ['note', 'Note', 'Click to place a note'],
  ['highlight', 'Highlight', 'Drag over an area'],
  ['redact', 'Redact', 'Drag over content to remove it from the file'],
];

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * Viewer, form filling, and annotation on one surface.
 *
 * The page is rendered WITHOUT the forms flag, so PDFium draws each widget frame but
 * not its value, leaving the rect free for a live control placed with PdfViewTransform.
 */
async function renderEditor() {
  const page = await state.document.page(state.pageIndex);
  const size = await page.size();
  const [fields, annotations] = await Promise.all([page.formFields(), page.annotations()]);

  // Zoom is a scale multiplier on top of fit-to-width.
  const available = Math.max(240, ($panel.clientWidth || 800) - 24);
  const fit = PdfViewTransform.fittingWidth(size, available);
  const scale = state.zoom == null ? fit.scale : state.zoom;
  const t = new PdfViewTransform(size, scale);

  // Re-render at the zoomed resolution rather than scaling the bitmap up.
  const image = await page.render({
    width: Math.round(t.viewSize.width),
    annotations: true,
    forms: false,
  });

  const canvas = el('canvas', { width: image.width, height: image.height });
  canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

  const stage = el('div', { className: 'stage' }, canvas);
  stage.style.width = `${t.viewSize.width}px`;
  stage.style.height = `${t.viewSize.height}px`;

  for (const field of fields) stage.append(fieldControl(field, t, page));
  if (state.selected != null) {
    const hit = annotations.find((a) => a.index === state.selected);
    if (hit) {
      const box = t.toViewRect(hit.rect);
      const marker = el('div', { className: 'sel' });
      Object.assign(marker.style, {
        left: `${box.x}px`, top: `${box.y}px`,
        width: `${Math.max(box.width, 8)}px`, height: `${Math.max(box.height, 8)}px`,
      });
      stage.append(marker);
    }
  }

  attachDrawing(stage, canvas, t, page, annotations);

  $panel.append(editorToolbar(page, annotations, scale, fit.scale),
                el('div', { className: 'stagewrap' }, stage),
                el('p', { className: 'muted' },
                   `${TOOLS.find(([k]) => k === state.tool)[2]} · ${fields.length} field(s) · ` +
                   `${annotations.length} annotation(s) · ${Math.round(scale / fit.scale * 100)}%`));
}

function editorToolbar(page, annotations, scale, fitScale) {
  const bar = el('div', { className: 'row' });
  for (const [key, label] of TOOLS) {
    const b = button(label, () => { state.tool = key; state.selected = null; draw(); });
    b.setAttribute('aria-selected', String(state.tool === key));
    b.id = `tool-${key}`;
    bar.append(b);
  }
  bar.append(el('span', { className: 'sep' }, ' '));

  const undo = button('Undo', async () => {
    if (!annotations.length) return;
    await page.removeAnnotation(annotations.length - 1);
    state.createdCount = Math.max(0, state.createdCount - 1);
    draw();
  }, state.createdCount === 0);
  undo.id = 'editor-undo';

  const del = button('Delete', async () => {
    await page.removeAnnotation(state.selected);
    state.selected = null;
    draw();
  }, state.selected == null);

  // Zoom: step through fixed levels, re-rendering each time.
  const zoomOut = button('−', () => { stepZoom(-1, scale, fitScale); });
  zoomOut.id = 'zoom-out';
  const zoomIn = button('+', () => { stepZoom(1, scale, fitScale); });
  zoomIn.id = 'zoom-in';
  const zoomFit = button('Fit', () => { state.zoom = null; draw(); });
  zoomFit.id = 'zoom-fit';

  const save = button('Save', async () => {
    const bytes = await state.document.toBytes();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = el('a', { href: url, download: 'pdfiumkit-edited.pdf', textContent: 'Download' });
    setStatus('Exported ' + (bytes.length / 1024).toFixed(0) + ' KB');
    bar.append(link);
  });
  save.id = 'editor-save';

  bar.append(undo, del, el('span', { className: 'sep' }, ' '), zoomOut, zoomFit, zoomIn, save);
  return bar;
}

function stepZoom(direction, current, fitScale) {
  const levels = ZOOM_STEPS.map((z) => z * fitScale);
  const i = levels.findIndex((l) => Math.abs(l - current) < 1e-6);
  const from = i >= 0 ? i : levels.findIndex((l) => l > current);
  const next = Math.min(levels.length - 1, Math.max(0, (from < 0 ? 2 : from) + direction));
  state.zoom = levels[next];
  draw();
}

/** A live control positioned on the field's own rectangle. */
function fieldControl(field, t, page) {
  const box = t.toViewRect(field.rect);
  const fontSize = Math.max(9, Math.min(18, box.height * 0.62));
  let control;

  switch (field.kind) {
    case 'text': {
      control = el('input', { type: 'text', value: field.value, className: 'fld' });
      control.style.fontSize = `${fontSize}px`;
      // Commit on blur or Enter, so the page re-renders once rather than per keystroke.
      const commit = async () => {
        if (control.value === field.value) return;
        await page.setText(control.value, field.annotationIndex);
        draw();
      };
      control.onblur = commit;
      control.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); control.blur(); } };
      break;
    }
    case 'checkBox':
    case 'radioButton': {
      // The widget draws its own box but never its check, so supply only the mark.
      control = el('button', { className: 'chk', textContent: field.isChecked ? '✓' : '' });
      control.style.fontSize = `${fontSize}px`;
      control.onclick = async () => {
        await page.setChecked(!field.isChecked, field.annotationIndex);
        draw();
      };
      break;
    }
    case 'comboBox':
    case 'listBox': {
      control = el('select', { className: 'fld' });
      field.options.forEach((option, i) => {
        control.append(el('option', {
          value: String(i), textContent: option || '(blank)',
          selected: field.selectedIndices.includes(i),
        }));
      });
      control.style.fontSize = `${fontSize}px`;
      control.onchange = async () => {
        await page.setOption(Number(control.value), true, field.annotationIndex);
        draw();
      };
      break;
    }
    default:
      control = el('div', { className: 'fld inert' });
  }

  control.id = `field-${field.annotationIndex}`;
  control.classList.add('overlay');
  Object.assign(control.style, {
    left: `${box.x}px`, top: `${box.y}px`,
    width: `${box.width}px`, height: `${box.height}px`,
  });
  return control;
}

/** Pointer handling for the drawing tools and selection. */
function attachDrawing(stage, canvas, t, page, annotations) {
  let start = null;
  let stroke = [];
  const preview = el('div', { className: 'preview' });

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  stage.onpointerdown = (e) => {
    if (e.target !== canvas) return;       // clicks on controls belong to them
    start = local(e);
    stroke = [start];
    if (state.tool === 'highlight' || state.tool === 'redact') {
      preview.className = state.tool === 'redact' ? 'preview redacting' : 'preview';
      stage.append(preview);
    }
    stage.setPointerCapture(e.pointerId);
  };

  stage.onpointermove = (e) => {
    if (!start) return;
    const p = local(e);
    if (state.tool === 'ink') stroke.push(p);
    if (state.tool === 'highlight' || state.tool === 'redact') {
      Object.assign(preview.style, {
        left: `${Math.min(start.x, p.x)}px`, top: `${Math.min(start.y, p.y)}px`,
        width: `${Math.abs(p.x - start.x)}px`, height: `${Math.abs(p.y - start.y)}px`,
      });
    }
  };

  stage.onpointerup = async (e) => {
    if (!start) return;
    const end = local(e);
    const from = start;
    start = null;
    preview.remove();

    if (state.tool === 'select') {
      const point = t.toPdf(end);
      const hit = [...annotations].reverse().find((a) => rectContains(a.rect, point));
      state.selected = hit ? hit.index : null;
      draw();
      return;
    }
    if (state.tool === 'note') {
      const text = prompt('Note contents');
      if (!text) return;
      const p = t.toPdf(end);
      await page.addNote({ left: p.x, bottom: p.y - 24, right: p.x + 24, top: p.y }, text);
      state.createdCount++;
      draw();
      return;
    }
    if (state.tool === 'ink') {
      const points = stroke.map((q) => t.toPdf(q));
      if (points.length < 2) return;
      await page.addInk(points, { red: 0, green: 90, blue: 220 });
      state.createdCount++;
      draw();
      return;
    }
    if (state.tool === 'redact') {
      const w = Math.abs(end.x - from.x), h = Math.abs(end.y - from.y);
      if (w < 4 || h < 4) return;
      const rect = t.toPdfRect({
        x: Math.min(from.x, end.x), y: Math.min(from.y, end.y), width: w, height: h,
      });
      await redactRegion(rect);
      return;
    }
    if (state.tool === 'highlight') {
      const w = Math.abs(end.x - from.x), h = Math.abs(end.y - from.y);
      if (w < 4 || h < 4) return;
      const r = t.toPdfRect({ x: Math.min(from.x, end.x), y: Math.min(from.y, end.y), width: w, height: h });
      await page.addHighlight([{
        p1: { x: r.left, y: r.top }, p2: { x: r.right, y: r.top },
        p3: { x: r.left, y: r.bottom }, p4: { x: r.right, y: r.bottom },
      }]);
      state.createdCount++;
      draw();
    }
  };
}


/**
 * Removes everything the dragged region touches.
 *
 * The report is shown rather than a quiet success: redaction is a compliance action,
 * and a drag that removed nothing looks exactly like one that worked.
 */
async function redactRegion(rect) {
  const report = await state.document.redact([
    { kind: 'region', rect, pageIndex: state.pageIndex },
  ]);

  const removed = [
    [report.textObjects, 'text object'],
    [report.textObjectsSplit, 'run trimmed'],
    [report.images, 'image'],
    [report.paths, 'path'],
    [report.annotations, 'annotation'],
  ].filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`);

  if (report.formFields.length) removed.push(`field ${report.formFields.join(', ')}`);

  // Save must be full: an incremental save leaves the original content stream, and the
  // removed content with it. The Save button uses toBytes() without a mode, which is full.
  setStatus(removed.length
    ? `Redacted ${removed.join(', ')} — save to write it out`
    : 'Nothing in that region to redact');
  state.selected = null;
  draw();
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

// MARK: - AI

/**
 * What a user sees when a feature cannot run, which on most devices today is what they
 * will see. The stub feature exists precisely so this path can be exercised before any
 * real feature does.
 */
async function renderAI() {
  const provider = state.aiEndpoint
    ? { async generate(request) {
          const response = await fetch(state.aiEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: request.prompt }),
          });
          if (!response.ok) throw new Error(`provider returned ${response.status}`);
          return { text: (await response.json()).text ?? '' };
        } }
    : undefined;

  const ai = new PdfiumAI(state.document, { provider });
  const availability = await ai.stub.availability();

  $panel.append(
    el('h3', {}, 'Availability'),
    el('p', { className: availability.kind === 'available' ? 'ok' : 'warn' },
       availability.kind === 'available'
         ? 'available'
         : `${availability.kind}${availability.reason ? ` — ${availability.reason}` : ''}`),
    el('p', { className: 'muted' },
       'The web has no general on-device model, so without a provider this is the honest '
       + 'answer rather than a failure. Availability is re-checked on every call: the user '
       + 'can turn the platform\'s AI off mid-session.'));

  const endpoint = el('input', {
    type: 'text', value: state.aiEndpoint ?? '',
    placeholder: 'https://your-server/generate',
  });
  endpoint.style.minWidth = '320px';

  $panel.append(
    el('h3', {}, 'Custom provider'),
    el('p', { className: 'muted' },
       'The SDK ships no model and no cloud account. A provider is yours to supply, and '
       + 'document content reaches it only because you configured it.'),
    el('div', { className: 'row' },
       endpoint,
       button('Use', () => { state.aiEndpoint = endpoint.value.trim() || null; draw(); }),
       button('Clear', () => { state.aiEndpoint = null; draw(); }, !state.aiEndpoint)));

  // AVL-4: the host asks for the download. Nothing here starts one on its own.
  $panel.append(
    el('div', { className: 'row' },
       button('Prepare', async () => {
         const after = await ai.stub.prepare((f) => setStatus(`preparing… ${Math.round(f * 100)}%`));
         setStatus(`prepare finished — ${after.kind}`);
       }),
       button('Run stub feature', async () => {
         const outcome = await ai.stub.run();
         setStatus('value' in outcome
           ? `answered "${outcome.value}" via ${outcome.source}`
           : `unavailable — ${outcome.reason}`,
           !('value' in outcome));
       })));

  $panel.append(el('p', { className: 'muted' },
    'Phase 0 ships no AI feature. The stub above does nothing except report whether it '
    + 'could, which is what makes this screen testable.'));
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

async function renderSignatures() {
  const signatures = await state.document.signatures();

  // Web ships no CMS implementation, so signing needs one from the app. There is no
  // browser API for it, and the demo is not going to pretend otherwise.
  $panel.append(
    el('h3', {}, 'Signing'),
    el('p', { className: 'muted' },
       'This SDK does not ship a CMS implementation for the browser. WebCrypto provides '
       + 'the primitives but not the container, so signing takes a CmsSigner you supply '
       + '— from a library such as PKI.js, or from your own backend. iOS and Android '
       + 'sign natively and need no such thing.'),
    el('pre', {},
       "const signed = await doc.sign({\n"
       + "  signer: { async sign(data) { /* return DER PKCS#7 */ } },\n"
       + "  reason: 'Approved',\n"
       + "});"),
  );
  if (!signatures.length) {
    $panel.append(el('p', { className: 'muted' }, 'This document carries no signatures.'));
    return;
  }

  for (const signature of signatures) {
    // A signature can be cryptographically intact and still cover only part of the
    // file. Showing "signed" without this distinction is how amended documents pass
    // review, so the warning is loud and sits above the details.
    const partial = !signature.coversWholeDocument;
    $panel.append(
      el('h3', {}, `Signature ${signature.index + 1}`),
      el('p', { className: partial ? 'warn' : 'ok' },
         partial
           ? 'Covers only part of the file — content was added after signing and is NOT protected.'
           : 'Covers the whole file.'),
      table([
        ['Type', signature.subFilter ?? '—'],
        ['Reason', signature.reason ?? '—'],
        ['Claimed signing time', signature.signingTime
          ? signature.signingTime.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
          : '—'],
        ['Signed ranges', signature.byteRange.join(', ')],
        ['PKCS#7 size', `${signature.contents.length} bytes`],
      ]),
    );

    // Two deliberately separate questions. Verifying without anchors answers trust
    // and, when it fails, hands back the chain; re-verifying with that chain's own
    // root as an anchor then isolates the cryptography.
    const plain = await state.document.verify(signature);
    const trusted = plain.kind === 'valid';
    const anchored = plain.kind === 'untrusted' && plain.chain.length
      ? await state.document.verify(signature, { trustAnchors: [plain.chain.at(-1).der] })
      : plain;
    const intact = anchored.kind === 'valid';

    $panel.append(
      el('h4', {}, 'Verification'),
      el('p', { className: intact ? 'ok' : 'warn' },
         intact
           ? 'Integrity: the signed bytes are unchanged.'
           : `Integrity: FAILED — ${anchored.kind}.`),
      el('p', { className: trusted ? 'ok' : 'warn' },
         trusted
           ? 'Trust: the chain reaches a trusted issuer.'
           : `Trust: not established — ${plain.kind === 'untrusted' ? plain.reason : plain.kind}.`),
      el('p', { className: 'muted' },
         'Revocation is not checked, so a valid result does not mean the certificate '
         + 'is still in good standing.'),
    );
  }
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
