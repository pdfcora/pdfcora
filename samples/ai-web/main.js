import { configureEngine, PdfDocument } from '../../web/dist/index.js';
import { PdfiumAI } from '../../web-ai/dist/index.js';

configureEngine({
  factory: async (options) => (await import('../../web/vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '../../web/vendor/pdfium.esm.wasm' : path),
});

const bytes = new Uint8Array(await (await fetch('sample.pdf')).arrayBuffer());
let pdf = await PdfDocument.open(bytes);

// No provider is configured here, so the SDK uses what the browser offers (Chrome's
// built-in Summarizer) and its own patterns. An app that has a hosted model passes
// `{ provider }`, and document text reaches it only because the app said so.
let ai = new PdfiumAI(pdf);

// AVL-2: the SDK reports whether a feature can run; it never downloads a model itself.
// Call `ai.summaries.prepare()` from a user gesture to download one.
const availability = await ai.summaries.availability();
document.getElementById('availability').textContent =
  availability.kind === 'available'
    ? 'Summaries: an on-device model is ready.'
    : `Summaries: ${availability.kind}${availability.reason ? ` (${availability.reason})` : ''} — the button will say so.`;

document.getElementById('summarise').onclick = async () => {
  const out = document.getElementById('summary');
  out.hidden = false;
  out.textContent = 'Working…';
  const result = await ai.summaries.summarize({ style: 'keyPoints' });
  // Either a result with the route that answered, or why nothing could.
  out.textContent = 'value' in result
    ? `${result.value.text}\n\n— ${result.source}`
    : `No summary: ${result.kind}${result.reason ? ` (${result.reason})` : ''}`;
};

document.getElementById('suggest').onclick = async () => {
  const review = await ai.redactions.suggest();
  const box = document.getElementById('review');

  // RED-4/HIL-1: the notice is shown with the suggestions, and nothing is applied
  // until a person ticks it and presses the button.
  box.innerHTML = `<p class="notice">${review.notice}</p>`;
  const list = document.createElement('ul');
  for (const s of review.suggestions) {
    const item = document.createElement('li');
    item.innerHTML = `<label><input type="checkbox" value="${s.id}" checked> ` +
      `<b>${s.category}</b> — ${s.text} <span class="status">(page ${s.pageIndex + 1}, ${s.source})</span></label>`;
    list.append(item);
  }
  box.append(list);

  const apply = document.createElement('button');
  apply.textContent = 'Redact the ticked items';
  apply.onclick = async () => {
    const accepted = [...box.querySelectorAll('input:checked')].map((i) => i.value);
    const applied = await review.apply(accepted);
    // Redaction removes the content itself, so this is about the saved bytes, not a
    // black box drawn over the page. `remaining` is empty when nothing survived it.
    const report = applied.report;
    box.insertAdjacentHTML('beforeend',
      `<p class="status">Removed ${report.textObjects} text object(s), rewrote ${report.textObjectsSplit}, ` +
      `on page(s) ${report.pages.map((p) => p + 1).join(', ')}. Still findable: ${applied.remaining.length}. ` +
      `Saved document: ${(await pdf.toBytes()).length} bytes.</p>`);

    // HIL-2: every change can be undone, which reopens the document as it was.
    const undo = document.createElement('button');
    undo.textContent = 'Undo';
    undo.onclick = async () => {
      pdf = await applied.undo();
      ai = new PdfiumAI(pdf);
      box.insertAdjacentHTML('beforeend', '<p class="status">Undone; the original document is open again.</p>');
    };
    box.append(undo);
  };
  box.append(apply);
};
