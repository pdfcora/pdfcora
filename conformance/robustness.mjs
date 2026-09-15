/**
 * Runs every document in a corpus through the full SDK surface and asserts the only
 * outcomes are "worked" or "raised a typed error" — never a process crash.
 *
 * A WASM abort takes the whole process down, so each document runs in a child that
 * announces the file before touching it. If the child dies, the parent attributes the
 * crash to that file and resumes after it.
 *
 * Usage: node conformance/robustness.mjs [corpusDir] [--child <file>]
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = '/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources';

function findPdfs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findPdfs(path));
    else if (entry.name.endsWith('.pdf')) out.push(path);
  }
  return out.sort();
}

/** Exercises the whole API surface against one file, in this process. */
async function exerciseOne(path) {
  const { PdfDocument, PdfError } = await import('../web/dist/index.js');

  const bytes = new Uint8Array(readFileSync(path));
  let document;
  try {
    document = await PdfDocument.open(bytes);
  } catch (error) {
    if (error instanceof PdfError) return { outcome: 'rejected', code: error.code };
    return { outcome: 'untyped-throw', code: String(error?.message ?? error) };
  }

  const touched = [];
  try {
    const pageCount = await document.pageCount();
    touched.push('pageCount');

    // Cap the work: this is a robustness sweep, not a benchmark.
    for (let i = 0; i < Math.min(pageCount, 3); i++) {
      const page = await document.page(i);
      await page.size();
      await page.render({ width: 80 });
      await page.text.string();
      await page.text.characterCount();
      await page.text.search('a');
      await page.annotations();
      await page.formFields();
    }
    touched.push('pages');

    await document.metadata();
    await document.permissions();
    await document.attachments();
    await document.outline();
    touched.push('document');

    await document.toBytes();
    touched.push('save');

    await document.close();
    return { outcome: 'ok', pageCount };
  } catch (error) {
    try { await document.close(); } catch { /* already failing */ }
    if (error instanceof PdfError) return { outcome: 'typed-error', code: error.code, touched };
    return { outcome: 'untyped-throw', code: String(error?.message ?? error), touched };
  }
}

// ── child mode ────────────────────────────────────────────────────────────────
const childIndex = process.argv.indexOf('--child');
if (childIndex !== -1) {
  const file = process.argv[childIndex + 1];
  const result = await exerciseOne(file);
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// ── parent mode ───────────────────────────────────────────────────────────────
const corpusDir = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : DEFAULT_CORPUS;

const files = findPdfs(corpusDir);
console.log(`running ${files.length} documents from ${corpusDir}\n`);

const results = [];
const tally = { ok: 0, rejected: 0, 'typed-error': 0, 'untyped-throw': 0, crash: 0, timeout: 0 };

for (const [i, file] of files.entries()) {
  const name = relative(corpusDir, file);
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', file], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  let result;
  if (run.status === 0 && run.stdout) {
    try {
      result = JSON.parse(run.stdout);
    } catch {
      result = { outcome: 'crash', code: 'unparseable child output' };
    }
  } else if (run.signal === 'SIGTERM') {
    result = { outcome: 'timeout', code: '30s' };
  } else {
    // Non-zero exit with no result: the engine took the process down.
    const stderr = (run.stderr ?? '').trim().split('\n').slice(-2).join(' ').slice(0, 160);
    result = { outcome: 'crash', code: stderr || `exit ${run.status}` };
  }

  tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
  results.push({ file: name, bytes: statSync(file).size, ...result });

  if (result.outcome === 'crash' || result.outcome === 'untyped-throw' || result.outcome === 'timeout') {
    console.log(`  ${result.outcome.toUpperCase().padEnd(14)} ${name}`);
    if (result.code) console.log(`  ${' '.repeat(14)} ${result.code}`);
  }
  if ((i + 1) % 50 === 0) console.log(`  … ${i + 1}/${files.length}`);
}

writeFileSync(join(HERE, 'robustness-report.json'),
  JSON.stringify({ corpus: corpusDir, ran: files.length, tally, results }, null, 2) + '\n');

console.log('\n── summary ──');
for (const [k, v] of Object.entries(tally)) if (v) console.log(`  ${k.padEnd(14)} ${v}`);
console.log(`\nreport: conformance/robustness-report.json`);

// The bar: a malformed document must raise, not crash and not throw something untyped.
const bad = tally.crash + tally['untyped-throw'] + tally.timeout;
process.exit(bad > 0 ? 1 : 0);
