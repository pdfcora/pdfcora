/**
 * Measures the SDK on large documents. The conformance corpus is tiny and synthetic;
 * this answers "what happens at 300 pages and 19 MB".
 *
 * Run `node conformance/make-large-doc.mjs` first.
 *
 * Usage: node --expose-gc conformance/scale.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PdfDocument } from '../web/dist/src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const LARGE = join(HERE, 'large');

const mb = (bytes) => (bytes / 1048576).toFixed(1);
const rss = () => process.memoryUsage().rss;

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
  };
}

for (const name of readdirSync(LARGE).filter((f) => f.endsWith('.pdf')).sort()) {
  const path = join(LARGE, name);
  const bytes = new Uint8Array(readFileSync(path));
  const baseline = rss();

  console.log(`\n── ${name}  (${mb(statSync(path).size)} MB on disk) ──`);

  let t = performance.now();
  const document = await PdfDocument.open(bytes);
  const openMs = performance.now() - t;
  const pageCount = await document.pageCount();
  console.log(`  open                 ${openMs.toFixed(0)} ms   ${pageCount} pages`);
  console.log(`  memory after open    +${mb(rss() - baseline)} MB`);

  // Thumbnail every page — the realistic worst case for a page-grid UI.
  t = performance.now();
  const renderTimes = [];
  for (let i = 0; i < pageCount; i++) {
    const start = performance.now();
    await (await document.page(i)).render({ width: 120 });
    renderTimes.push(performance.now() - start);
  }
  const totalMs = performance.now() - t;
  const r = stats(renderTimes);
  console.log(`  thumbnail all pages  ${(totalMs / 1000).toFixed(1)} s total`);
  console.log(`    per page           mean ${r.mean.toFixed(1)} ms · p50 ${r.p50.toFixed(1)} · p95 ${r.p95.toFixed(1)} · max ${r.max.toFixed(1)}`);
  console.log(`  memory after renders +${mb(rss() - baseline)} MB`);

  // One full-size render, the common viewer case.
  t = performance.now();
  await (await document.page(0)).render({ width: 1600 });
  console.log(`  single 1600px render ${(performance.now() - t).toFixed(0)} ms`);

  // Text across the whole document — the search path.
  t = performance.now();
  let chars = 0;
  for (let i = 0; i < pageCount; i++) chars += (await (await document.page(i)).text.string()).length;
  console.log(`  text, all pages      ${(performance.now() - t).toFixed(0)} ms   ${chars} chars`);

  t = performance.now();
  const saved = await document.toBytes();
  console.log(`  save                 ${(performance.now() - t).toFixed(0)} ms   ${mb(saved.length)} MB`);

  await document.close();
  globalThis.gc?.();
  console.log(`  memory after close   +${mb(rss() - baseline)} MB  (leak check)`);
}
