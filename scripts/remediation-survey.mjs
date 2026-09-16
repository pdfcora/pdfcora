/**
 * Runs remediation over a corpus of real-world PDFs and judges the result with veraPDF.
 *
 *   node scripts/remediation-survey.mjs [corpus dir] [--limit N] [--out report.json]
 *
 * For every document: can it be opened, is it tagged already, does it have a text layer
 * at all (a scan does not, and remediation cannot help it), what does remediation propose,
 * does applying it produce a PDF/UA-1 compliant file. Writes a JSON report and prints a
 * summary. Nothing in the corpus is modified; output goes to a temporary directory.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, relative } from 'node:path';
import { configureLicenseForTesting } from '../web/dist/license/state.js';

// Without a key every page carries the trial watermark, whose standard font is not
// embedded, so every document fails 7.21.4.1 and none can be compliant. The survey is
// about what a licensed app produces, so it uses the conformance fixture's test key.
const LICENSE = JSON.parse(readFileSync(new URL('../conformance/license/cases.json', import.meta.url), 'utf8'));
await configureLicenseForTesting({
  publicKey: LICENSE.publicKey, revoked: LICENSE.revoked, releaseDate: LICENSE.releaseDate,
  host: null, key: LICENSE.fullKey,
});

const { PdfDocument } = await import('../web/dist/index.js');
const { PdfiumAI } = await import('../web-ai/dist/index.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const root = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true)
  ?? `${process.env.HOME}/pdfiumkit-corpus/real-world`;
const limit = Number(flag('--limit', '0')) || Infinity;
const reportPath = flag('--out', 'build/remediation-survey.json');
const verapdf = process.env.VERAPDF ?? `${process.env.HOME}/.cache/verapdf/app/verapdf`;
const work = mkdtempSync(join(tmpdir(), 'pdfiumkit-survey-'));

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (extname(entry.name).toLowerCase() === '.pdf') yield path;
  }
}

/** veraPDF's verdict plus the clauses that failed, which is what says *why*. */
function checkUA1(path) {
  let report;
  try {
    report = execFileSync(verapdf, ['--flavour', 'ua1', '--format', 'mrr', path],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // veraPDF exits non-zero for a non-compliant file; the report is still on stdout.
    report = error.stdout;
    if (!report) return { compliant: false, failed: [`verapdf: ${String(error.message).slice(0, 120)}`] };
  }
  if (/isCompliant="true"/.test(report)) return { compliant: true, failed: [] };
  const failed = [...report.matchAll(/clause="([^"]+)"\s+testNumber="(\d+)"[^>]*?failedChecks="([1-9]\d*)"/g)]
    .map((m) => `${m[1]}-${m[2]}`);
  return { compliant: false, failed: [...new Set(failed)].slice(0, 10) };
}

const files = [...walk(root)].slice(0, limit);
console.error(`${files.length} PDFs under ${root}`);
const results = [];

for (const [n, path] of files.entries()) {
  const name = relative(root, path);
  const row = { file: name, bytes: statSync(path).size };
  let pdf;
  try {
    pdf = await PdfDocument.open(new Uint8Array(readFileSync(path)));
    row.pages = await pdf.pageCount();
    row.tagged = await pdf.isTagged();

    // A page with almost no text is a scan; remediation reads the text layer, so it has
    // nothing to work with. This is measured, not assumed.
    let characters = 0;
    for (let p = 0; p < Math.min(row.pages, 5); p++) characters += (await (await pdf.page(p)).text.string()).length;
    row.charsPerPage = Math.round(characters / Math.max(1, Math.min(row.pages, 5)));
    row.scanned = row.charsPerPage < 50;

    if (!row.tagged && !row.scanned) {
      const started = Date.now();
      const review = await new PdfiumAI(pdf).remediation.suggest();
      row.suggestMs = Date.now() - started;
      row.blocks = review.blocks.length;
      row.byType = {};
      for (const block of review.blocks) row.byType[block.type] = (row.byType[block.type] ?? 0) + 1;
      // Real documents rarely carry a /Title and often have no heading to borrow one
      // from, and PDF/UA requires one — so the host supplies it, as an app would.
      const title = name.split('/').pop().replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').slice(0, 120);
      const applying = Date.now();
      const tagged = await review.apply({ language: 'en', title });
      row.applyMs = Date.now() - applying;
      const out = join(work, `${n}.pdf`);
      writeFileSync(out, await tagged.toBytes());
      Object.assign(row, checkUA1(out));
      await tagged.close();
    }
  } catch (error) {
    row.error = `${error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 160)}`;
  } finally {
    await pdf?.close().catch(() => {});
  }
  results.push(row);
  if ((n + 1) % 25 === 0) console.error(`  ${n + 1}/${files.length}`);
}

writeFileSync(reportPath, JSON.stringify(results, null, 2));

const count = (p) => results.filter(p).length;
const remediated = results.filter((r) => r.blocks !== undefined);
console.log(`
Documents           ${results.length}
  unopenable        ${count((r) => r.error && r.pages === undefined)}
  tagged already    ${count((r) => r.tagged)}
  scanned (no text) ${count((r) => r.scanned)}
  remediated        ${remediated.length}
    PDF/UA-1 pass   ${count((r) => r.compliant === true)}
    PDF/UA-1 fail   ${count((r) => r.compliant === false)}
    errored         ${count((r) => r.error && r.pages !== undefined)}
Report: ${reportPath}`);

const clauses = {};
for (const row of results) for (const clause of row.failed ?? []) clauses[clause] = (clauses[clause] ?? 0) + 1;
const top = Object.entries(clauses).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (top.length) console.log('\nMost common PDF/UA-1 failures:\n' + top.map(([c, n]) => `  ${n.toString().padStart(4)}  ${c}`).join('\n'));
