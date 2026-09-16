/** Turns build/remediation-survey.json into the table in docs/accessibility/remediation-real-world.md. */
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(process.argv[2] ?? 'build/remediation-survey.json', 'utf8'));
const count = (p) => rows.filter(p).length;
const remediated = rows.filter((r) => r.blocks !== undefined);
const sum = (f) => remediated.reduce((n, r) => n + (r[f] ?? 0), 0);

const clauses = {};
for (const row of rows) for (const clause of row.failed ?? []) clauses[clause] = (clauses[clause] ?? 0) + 1;

const sources = {};
for (const row of rows) {
  const key = row.file.split('/')[0];
  const s = (sources[key] ??= { docs: 0, tagged: 0, scanned: 0, errored: 0, remediated: 0, pass: 0 });
  s.docs++;
  if (row.tagged) s.tagged++;
  if (row.scanned) s.scanned++;
  if (row.error) s.errored++;
  if (row.blocks !== undefined) s.remediated++;
  if (row.compliant) s.pass++;
}

console.log(`| Documents | ${rows.length} |
| --- | --- |
| Opened without error | ${count((r) => r.pages !== undefined)} |
| Tagged already, so refused | ${count((r) => r.tagged)} |
| Scanned, no text layer | ${count((r) => r.scanned)} |
| Refused with a typed error | ${count((r) => r.error && r.pages !== undefined)} |
| **Remediated** | **${remediated.length}** |
| …PDF/UA-1 compliant afterwards | ${count((r) => r.compliant === true)} |
| …still not compliant | ${count((r) => r.compliant === false)} |
`);
console.log(`Pages ${rows.reduce((n, r) => n + (r.pages ?? 0), 0)}, blocks proposed ${sum('blocks')}, ` +
  `suggest ${(sum('suggestMs') / 1000).toFixed(0)} s and apply ${(sum('applyMs') / 1000).toFixed(0)} s in total.\n`);

console.log('| Source | Documents | Tagged already | Remediated | Compliant |');
console.log('| --- | --- | --- | --- | --- |');
for (const [name, s] of Object.entries(sources)) {
  console.log(`| ${name} | ${s.docs} | ${s.tagged} | ${s.remediated} | ${s.pass} |`);
}

console.log('\n| Clause | Documents failing | What it is |');
console.log('| --- | --- | --- |');
for (const [clause, n] of Object.entries(clauses).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`| ${clause} | ${n} | |`);
}

const slow = [...remediated].sort((a, b) => (b.suggestMs + b.applyMs) - (a.suggestMs + a.applyMs)).slice(0, 3);
console.log('\nSlowest:');
for (const r of slow) console.log(`  ${r.file} — ${r.pages} pages, ${r.blocks} blocks, ${((r.suggestMs + r.applyMs) / 1000).toFixed(1)} s`);
