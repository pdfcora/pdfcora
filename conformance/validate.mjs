import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ['basic', 'form', 'encrypted', 'annotation', 'text', 'regression', 'signature'];
const OPEN_ERRORS = ['password', 'format', 'file', 'security', 'page', 'unknown'];

export function validateExpectations(expectations, corpus) {
  const problems = [];
  const named = new Set(corpus.files.map(f => f.name));
  const covered = new Set(Object.keys(expectations.documents ?? {}));

  if (!expectations.engine) problems.push('missing top-level "engine"');

  for (const name of covered) {
    if (!named.has(name)) problems.push(`expectations reference ${name}, absent from corpus.json`);
  }
  for (const name of named) {
    if (!covered.has(name)) problems.push(`corpus file ${name} has no expectations`);
  }

  for (const [name, doc] of Object.entries(expectations.documents ?? {})) {
    const at = `${name}:`;
    if (!CATEGORIES.includes(doc.category)) problems.push(`${at} unknown category ${doc.category}`);
    if (typeof doc.opens !== 'boolean') problems.push(`${at} "opens" must be boolean`);

    if (doc.opens === false) {
      if (!OPEN_ERRORS.includes(doc.openError)) {
        problems.push(`${at} openError required when opens is false`);
      }
      continue;
    }
    if (doc.pages && typeof doc.pageCount === 'number' && doc.pages.length !== doc.pageCount) {
      problems.push(`${at} pageCount ${doc.pageCount} disagrees with ${doc.pages.length} page entries`);
    }
    for (const [i, p] of (doc.pages ?? []).entries()) {
      if (!(p.width > 0) || !(p.height > 0)) problems.push(`${at} page ${i} has non-positive dimensions`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const expPath = join(HERE, 'expectations.json');
  if (!existsSync(expPath)) {
    console.error('no expectations.json; run: node conformance/generate.mjs');
    process.exit(1);
  }
  const problems = validateExpectations(
    JSON.parse(readFileSync(expPath, 'utf8')),
    JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'))
  );
  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('expectations valid');
}
