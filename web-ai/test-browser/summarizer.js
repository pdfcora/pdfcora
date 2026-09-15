// Runs pdfiumkit-ai's summaries through Chrome's built-in Summarizer on the shared documents and
// reports what came back. Driven by scripts/measure-chrome-summarizer.mjs in a real Chrome profile
// that has the model; the page exposes window.measure for the runner.
import { configureEngine, PdfDocument } from '/web/dist/index.js';
import { PdfiumAI } from '/web-ai/dist/index.js';

configureEngine({
  factory: async (options) => (await import('/web/vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '/web/vendor/pdfium.esm.wasm' : path),
});

const open = async (path) => PdfDocument.open(new Uint8Array(await (await fetch(path)).arrayBuffer()));

window.measure = async () => {
  const report = { chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] };
  report.globalPresent = typeof Summarizer !== 'undefined';
  const contract = await open('/conformance/fixtures/contract.pdf');
  const ai = new PdfiumAI(contract);
  report.availability = await ai.summaries.availability();
  report.availabilityGerman = await ai.summaries.availability('de');
  report.availabilityJapanese = await ai.summaries.availability('ja');

  const text = (await Promise.all(Array.from({ length: await contract.pageCount() }, async (_, i) => (await contract.page(i)).text.string()))).join('\n');
  report.documentChars = text.length;
  const created = await Summarizer.create({ type: 'tldr', format: 'plain-text', length: 'medium' });
  report.inputQuota = created.inputQuota;
  if (created.measureInputUsage) {
    // Marginal characters per token, so the fixed prompt the API adds does not skew it.
    const pii = await open('/conformance/redaction/pii.pdf');
    const sample = (await (await pii.page(0)).text.string()) + (await (await pii.page(1)).text.string());
    const one = await created.measureInputUsage(sample);
    const two = await created.measureInputUsage(sample + sample);
    report.inputUsage = { chars: sample.length, tokens: one, doubledTokens: two };
    report.charsPerToken = Number((sample.length / (two - one)).toFixed(2));
    report.documentText = text;
  }
  created.destroy();

  for (const style of ['paragraph', 'keyPoints']) {
    const started = performance.now();
    const result = await ai.summaries.summarize({ style });
    report[style] = { ms: Math.round(performance.now() - started), source: result.source, kind: result.kind, text: result.value?.text };
  }
  const german = await open('/conformance/redaction/pii.pdf');
  const started = performance.now();
  const result = await new PdfiumAI(german).summaries.summarize({ pages: { from: 1, to: 1 }, language: 'de' });
  report.germanPage = { ms: Math.round(performance.now() - started), source: result.source, kind: result.kind, reason: result.reason, text: result.value?.text };
  return report;
};
document.getElementById('result').textContent = 'ready';

// A long, token-dense document: digits, emails and IBANs cost more tokens per character than prose.
window.dense = async () => {
  const { openChromeSummarizer } = await import('/web-ai/dist/chrome.js');
  const { summariseInWindows } = await import('/web-ai/dist/summaries.js');
  const pii = await open('/conformance/redaction/pii.pdf');
  const page = (await (await pii.page(0)).text.string()) + '\n' + (await (await pii.page(1)).text.string());
  const pages = Array.from({ length: 30 }, () => page);
  const summarizer = await openChromeSummarizer('paragraph', undefined, pages.join('\n'));
  const started = performance.now();
  let calls = 0;
  try {
    const text = await summariseInWindows(pages, summarizer.limitChars, (part) => { calls++; return summarizer.summarise(part); });
    return { ok: true, limitChars: summarizer.limitChars, chars: pages.join('').length, calls, ms: Math.round(performance.now() - started), text };
  } catch (error) {
    return { ok: false, limitChars: summarizer.limitChars, calls, error: `${error.name}: ${error.message}` };
  } finally {
    summarizer.close();
  }
};
