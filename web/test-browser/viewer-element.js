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
