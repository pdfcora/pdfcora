// Tests for PdfViewerElement that need a real DOM and canvas, which Node has neither of.
// Run by scripts/test-web-browser.sh in headless Chrome at a device pixel ratio of 2; the
// outcome is shown in #result and posted back to the runner.
import { configureEngine, defaultToolbar, PdfDocument, PdfViewerElement } from '../dist/index.js';

configureEngine({
  factory: async (options) => (await import('../vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '../vendor/pdfium.esm.wasm' : path),
});

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const open = async () => PdfDocument.open(new Uint8Array(await (await fetch('../../conformance/corpus/hello_world.pdf')).arrayBuffer()));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

try {
  const host = document.getElementById('host');
  const pdf = await open();
  await PdfViewerElement.mount(host, pdf);
  const canvas = host.querySelector('canvas');
  const cssWidth = canvas.getBoundingClientRect().width;

  // The iOS and web components once drew a 1x bitmap on a high-density screen.
  check('the page bitmap has device pixels for its CSS size',
    devicePixelRatio === 2 && Math.abs(canvas.width - cssWidth * devicePixelRatio) <= 1,
    `devicePixelRatio=${devicePixelRatio} canvas=${canvas.width}px css=${cssWidth}px`);

  // The toolbar scrolls rather than wraps; an item past the edge is fine, one that cannot
  // be brought into view is not. The host is narrow so that some items start off-screen.
  const bar = canvas.parentElement.previousElementSibling;
  check('the default toolbar overflows the narrow host', bar.scrollWidth > bar.clientWidth,
    `scrollWidth=${bar.scrollWidth} clientWidth=${bar.clientWidth}`);
  for (const item of defaultToolbar.items.filter((i) => i.item.kind !== 'spacer' && i.item.kind !== 'divider')) {
    const button = document.getElementById(item.id);
    button?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    await frame();
    const b = button?.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    check(`toolbar item ${item.id} can be scrolled into view`,
      b && b.left >= r.left - 1 && b.right <= r.right + 1, b ? `button ${b.left}-${b.right} in bar ${r.left}-${r.right}` : 'missing');
  }

  document.getElementById('zoom-in').click();
  for (let i = 0; i < 50 && canvas.getBoundingClientRect().width <= cssWidth; i++) await new Promise((r) => setTimeout(r, 20));
  check('zoom in makes the page larger', canvas.getBoundingClientRect().width > cssWidth,
    `before=${cssWidth} after=${canvas.getBoundingClientRect().width}`);

  // Keyboard (A11Y-3): controls show a focus ring, and the page zooms from the keyboard.
  const zoomButton = document.getElementById('zoom-out');
  zoomButton.focus();
  check('a focused toolbar button shows a focus indicator', getComputedStyle(zoomButton).outlineStyle !== 'none',
    `outline=${getComputedStyle(zoomButton).outlineStyle}`);
  const stage = canvas.parentElement;
  stage.focus();
  const beforeKey = canvas.getBoundingClientRect().width;
  stage.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
  for (let i = 0; i < 50 && canvas.getBoundingClientRect().width <= beforeKey; i++) await new Promise((r) => setTimeout(r, 20));
  check('+ on the focused page zooms in', document.activeElement === stage && canvas.getBoundingClientRect().width > beforeKey,
    `before=${beforeKey} after=${canvas.getBoundingClientRect().width}`);

  // Screen readers: the tagged document's structure is in the accessible layer, the bitmap is hidden.
  const taggedHost = document.createElement('div');
  taggedHost.style.cssText = 'width:400px;height:500px';
  document.body.append(taggedHost);
  const tagged = await PdfDocument.open(new Uint8Array(await (await fetch('../../conformance/alt-text/tagged.pdf')).arrayBuffer()));
  await PdfViewerElement.mount(taggedHost, tagged);
  const layer = taggedHost.querySelector('.pdf-accessible-content');
  for (let i = 0; i < 100 && !layer?.querySelector('h1'); i++) await frame();
  check('the canvas is hidden from screen readers', taggedHost.querySelector('canvas')?.getAttribute('aria-hidden') === 'true');
  check('the title is an h1', layer?.querySelector('h1')?.textContent === 'Annual report 2026', layer?.innerHTML.slice(0, 200));
  check('the chart is an image with its alternate text',
    layer?.querySelector('[role="img"]')?.getAttribute('aria-label') === 'Bar chart of revenue by region');
  check('the accessible layer is visually hidden', layer && layer.getBoundingClientRect().width <= 1);

  // Review mode: a mark over the page, tapped once to accept, then applied.
  const reviewHost = document.createElement('div');
  reviewHost.style.cssText = 'width:400px;height:500px';
  document.body.append(reviewHost);
  let applied = null;
  await PdfViewerElement.mount(reviewHost, await open(), {
    review: {
      marks: [{ id: 'm1', pageIndex: 0, rects: [{ left: 0, bottom: 0, right: 612, top: 792 }], state: 'pending', label: 'Anna' }],
      notice: 'Suggestions may be incomplete. Review the whole document.',
      onApply: (ids) => { applied = ids; },
    },
  });
  check('a mark shows its label', reviewHost.querySelector('[data-mark-id="m1"]')?.textContent === 'Anna');
  check('the review notice is shown', document.getElementById('review-notice')?.textContent.includes('may be incomplete'));
  const reviewCanvas = reviewHost.querySelector('canvas');
  const box = reviewCanvas.getBoundingClientRect();
  const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true };
  reviewCanvas.dispatchEvent(new PointerEvent('pointerdown', at));
  reviewCanvas.dispatchEvent(new PointerEvent('pointerup', at));
  for (let i = 0; i < 50 && !document.getElementById('review-counts')?.textContent.startsWith('1 accepted'); i++) await frame();
  check('tapping a mark accepts it', document.getElementById('review-counts')?.textContent.startsWith('1 accepted'),
    document.getElementById('review-counts')?.textContent);
  check('an accepted mark is drawn as accepted', reviewHost.querySelector('[data-mark-id="m1"]')?.dataset.markState === 'accepted');
  document.getElementById('review-apply').click();
  for (let i = 0; i < 50 && applied === null; i++) await frame();
  check('apply hands over the accepted ids', JSON.stringify(applied) === '["m1"]', JSON.stringify(applied));
  const markButton = reviewHost.querySelector('[data-mark-id="m1"]');
  check('a mark is a button a keyboard can reach', markButton?.tagName === 'BUTTON' && markButton.getAttribute('aria-label') === 'Anna: accepted',
    `${markButton?.tagName} ${markButton?.getAttribute('aria-label')}`);
  markButton.click();
  for (let i = 0; i < 50 && reviewHost.querySelector('[data-mark-id="m1"]')?.dataset.markState !== 'rejected'; i++) await frame();
  check('activating a mark button cycles it', reviewHost.querySelector('[data-mark-id="m1"]')?.dataset.markState === 'rejected');

  // Text scaling (A11Y-3): with a much larger default font, controls grow and nothing clips.
  document.documentElement.style.fontSize = '32px';
  const bigHost = document.createElement('div');
  bigHost.style.cssText = 'width:360px;height:500px';
  document.body.append(bigHost);
  await PdfViewerElement.mount(bigHost, await open(), {
    review: { marks: [], notice: 'Suggestions may be incomplete.', onApply: () => {} },
  });
  const bigButton = bigHost.querySelector('button');
  const bigBar = bigButton.parentElement;
  check('toolbar text follows the reader\'s text size', parseFloat(getComputedStyle(bigButton).fontSize) >= 29,
    getComputedStyle(bigButton).fontSize);
  check('the toolbar grows instead of clipping its buttons',
    bigBar.getBoundingClientRect().height >= bigButton.getBoundingClientRect().height,
    `bar=${bigBar.getBoundingClientRect().height} button=${bigButton.getBoundingClientRect().height}`);
  const hostRight = bigHost.getBoundingClientRect().right;
  const reviewButtons = [...bigHost.querySelectorAll('[id^="review-"]')].filter((e) => e.tagName === 'BUTTON');
  check('review buttons wrap inside the component at large text',
    reviewButtons.length >= 3 && reviewButtons.every((b) => b.getBoundingClientRect().right <= hostRight + 1),
    reviewButtons.map((b) => Math.round(b.getBoundingClientRect().right)).join(',') + ` host=${hostRight}`);
  document.documentElement.style.fontSize = '';

  // Drawing feedback: the gesture is drawn while the pointer is down, and ink follows the
  // path the pointer took rather than a straight line between its ends.
  const drawHost = document.createElement('div');
  drawHost.style.cssText = 'width:420px;height:520px';
  document.body.append(drawHost);
  const drawDoc = await open();
  await PdfViewerElement.mount(drawHost, drawDoc);
  const drawCanvas = drawHost.querySelector('canvas');
  const preview = drawHost.querySelector('.pdf-gesture-preview');
  const pointAt = (x, y) => {
    const box = drawCanvas.getBoundingClientRect();
    return { clientX: box.left + x, clientY: box.top + y, pointerId: 1, bubbles: true };
  };
  // Synthetic pointer events have no real capture target.
  drawCanvas.setPointerCapture = () => {};

  drawHost.querySelector('#tool-ink').click();
  drawCanvas.dispatchEvent(new PointerEvent('pointerdown', pointAt(40, 40)));
  for (const [x, y] of [[60, 55], [80, 44], [100, 70], [120, 52]]) {
    drawCanvas.dispatchEvent(new PointerEvent('pointermove', pointAt(x, y)));
  }
  const line = preview?.querySelector('polyline');
  check('an ink stroke is drawn while the pointer is still down',
    Boolean(line) && line.getAttribute('points').split(' ').length >= 5,
    `points=${line?.getAttribute('points')}`);

  const inkBefore = (await (await drawDoc.page(0)).annotations()).length;
  drawCanvas.dispatchEvent(new PointerEvent('pointerup', pointAt(120, 52)));
  for (let i = 0; i < 100 && (await (await drawDoc.page(0)).annotations()).length === inkBefore; i++) await frame();
  const ink = (await (await drawDoc.page(0)).annotations()).find((a) => a.kind === 'ink');
  check('the committed ink follows the path, not a straight line',
    ink?.strokes?.[0]?.length >= 5, `points=${ink?.strokes?.[0]?.length}`);
  check('the preview is cleared once the stroke is committed',
    preview.childElementCount === 0, `children=${preview.childElementCount}`);

  // A highlight or redaction shows the region it will cover before it is committed.
  drawHost.querySelector('#tool-highlight').click();
  drawCanvas.dispatchEvent(new PointerEvent('pointerdown', pointAt(30, 200)));
  drawCanvas.dispatchEvent(new PointerEvent('pointermove', pointAt(160, 240)));
  const region = preview?.querySelector('rect');
  check('a highlight shows the region it will cover',
    Boolean(region) && Math.round(Number(region.getAttribute('width'))) === 130,
    `rect=${region?.getAttribute('width')}x${region?.getAttribute('height')}`);
  drawCanvas.dispatchEvent(new PointerEvent('pointercancel', pointAt(160, 240)));
  check('cancelling the gesture clears the preview', preview.childElementCount === 0);

  // A note carries text, so the text is typed before the annotation is created.
  drawHost.querySelector('#tool-note').click();
  drawCanvas.dispatchEvent(new PointerEvent('pointerdown', pointAt(70, 300)));
  drawCanvas.dispatchEvent(new PointerEvent('pointerup', pointAt(70, 300)));
  const editor = drawHost.querySelector('#note-text');
  check('placing a note opens a text editor', editor && editor.style.display === 'block',
    `display=${editor?.style.display}`);

  const notesBefore = (await (await drawDoc.page(0)).annotations()).length;
  editor.value = 'Check clause 4.2';
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 100 && (await (await drawDoc.page(0)).annotations()).length === notesBefore; i++) await frame();
  const note = (await (await drawDoc.page(0)).annotations()).find((a) => a.contents === 'Check clause 4.2');
  check('the typed text becomes the note', Boolean(note), `contents=${note?.contents}`);
  check('the editor closes once the note is made', editor.style.display === 'none');

  // Icons: a drawing replaces the label, so the accessible name has to survive it.
  const inkButton = drawHost.querySelector('#tool-ink');
  check('a toolbar button is an icon with an accessible name',
    inkButton.querySelector('svg') !== null && inkButton.getAttribute('aria-label') === 'Ink',
    `label=${inkButton.getAttribute('aria-label')} svg=${inkButton.querySelector('svg') !== null}`);
  check('the selected tool is announced as pressed',
    drawHost.querySelector('#tool-note').getAttribute('aria-pressed') === 'true',
    `note=${drawHost.querySelector('#tool-note').getAttribute('aria-pressed')}`);

  // The toolbar must survive an edit: focusing the page after the note editor closes
  // once scrolled a fixed-height host and took the toolbar off the top of it.
  const drawBar = drawHost.querySelector('#tool-ink').parentElement;
  check('the toolbar is still in view after a note is entered',
    drawBar.getBoundingClientRect().top >= drawHost.getBoundingClientRect().top - 1,
    `bar=${drawBar.getBoundingClientRect().top} host=${drawHost.getBoundingClientRect().top}`);

  // Form filling: the page is drawn without its form layer and real controls sit on the
  // field rects, so a form is filled in rather than looked at.
  const formHost = document.createElement('div');
  formHost.style.cssText = 'width:520px;height:600px';
  document.body.append(formHost);
  const formDoc = await PdfDocument.open(new Uint8Array(await (await fetch('../../conformance/forms/forms.pdf')).arrayBuffer()));
  await PdfViewerElement.mount(formHost, formDoc);
  const layerFields = formHost.querySelector('.pdf-form-fields');
  for (let i = 0; i < 100 && !layerFields?.querySelector('input'); i++) await frame();
  const textInput = layerFields?.querySelector('input[type="text"]');
  check('a text field gets a real input on the page', Boolean(textInput),
    `controls=${layerFields?.childElementCount}`);
  check('a checkbox gets a real checkbox', Boolean(layerFields?.querySelector('input[type="checkbox"]')));

  textInput.value = 'Jane Doe';
  textInput.dispatchEvent(new Event('change', { bubbles: true }));
  const named = async () => (await (await formDoc.page(0)).formFields()).some((f) => f.value === 'Jane Doe');
  for (let i = 0; i < 100 && !(await named()); i++) await frame();
  check('typing into it writes the value into the document', await named(),
    JSON.stringify((await (await formDoc.page(0)).formFields()).slice(0, 3).map((f) => f.value)));

  const closed = await open();
  await closed.close();
  const other = document.createElement('div');
  document.body.append(other);
  try {
    await PdfViewerElement.mount(other, closed);
    check('mounting a closed document rejects with closed', false, 'mount resolved');
  } catch (error) {
    check('mounting a closed document rejects with closed', error?.code === 'closed', String(error));
  }

  // WCAG 2.1 A and AA rules from axe-core over every component mounted above (A11Y-1).
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '../node_modules/axe-core/axe.min.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  const audit = await globalThis.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    exclude: [['#result']],
  });
  check('axe finds no WCAG 2.1 A/AA violations in the components', audit.violations.length === 0,
    audit.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('; ')}`).join(' | '));
  window.__axe = audit.violations;

  // WebMCP (Chrome behind --enable-blink-features=WebMCP): the agent tools are registered and run.
  check('the browser has WebMCP', Boolean(document.modelContext));
  if (document.modelContext) {
    const ai = await import('../../web-ai/dist/index.js');
    const unregister = ai.registerWebMcpTools(new ai.PdfAgentSession(await open()));
    const tools = await document.modelContext.getTools();
    const info = tools.find((t) => t.name === 'pdf_document_info');
    check('the agent tools are registered with WebMCP', tools.length === ai.agentTools.length && info, tools.map((t) => t.name).join(','));
    const answer = info ? JSON.parse(JSON.parse(await document.modelContext.executeTool(info, '{}')).content[0].text) : null;
    check('a WebMCP call runs a tool on the document', answer?.pageCount === 1, JSON.stringify(answer));
    unregister();
    check('unregistering removes the tools', (await document.modelContext.getTools()).length === 0);
  }
} catch (error) {
  check('the tests ran to the end', false, String(error?.stack ?? error));
}

const failed = results.filter((r) => !r.ok);
const report =
  `${failed.length === 0 ? 'PASS' : 'FAIL'} ${results.length - failed.length}/${results.length}\n` +
  results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`).join('\n');
document.getElementById('result').textContent = report;
// The runner's server collects this; opened by hand, the page just shows the report.
fetch('/__result', { method: 'POST', body: report }).catch(() => {});
