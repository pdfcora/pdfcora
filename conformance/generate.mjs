import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdfium } from '../tools/host/pdfium-host.mjs';
import { validateExpectations } from './validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = 'chromium/7243';
const META_KEYS = ['Title', 'Author', 'Subject', 'Creator', 'Producer'];

function popplerPageCount(path) {
  try {
    const out = execFileSync('pdfinfo', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^Pages:\s+(\d+)$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;   // encrypted or damaged files legitimately defeat pdfinfo
  }
}

const corpus = JSON.parse(readFileSync(join(HERE, 'corpus.json'), 'utf8'));
const pdfium = await loadPdfium();
const documents = {};
const disagreements = [];

for (const { name, category } of corpus.files) {
  const path = join(HERE, 'corpus', name);
  const bytes = readFileSync(path);
  let doc;
  try {
    doc = pdfium.openDocument(bytes);
  } catch (e) {
    const m = e.message.match(/load failed: (\w+)/);
    documents[name] = { category, opens: false, openError: m ? m[1] : 'unknown' };
    continue;
  }

  const pageCount = doc.pageCount;
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    const { width, height } = doc.pageSize(i);
    pages.push({ width: Number(width.toFixed(2)), height: Number(height.toFixed(2)) });
  }

  const metadata = {};
  for (const k of META_KEYS) {
    const v = doc.metadata(k);
    if (v) metadata[k] = v;
  }

  documents[name] = { category, opens: true, pageCount, pages };
  if (Object.keys(metadata).length) documents[name].metadata = metadata;

  const cross = popplerPageCount(path);
  if (cross !== null && cross !== pageCount) {
    disagreements.push(`${name}: pdfium=${pageCount} poppler=${cross}`);
  }
  doc.close();
}

const expectations = { engine: ENGINE, generated: new Date().toISOString(), documents };
const problems = validateExpectations(expectations, corpus);
if (problems.length) {
  console.error('generated expectations are invalid:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

writeFileSync(join(HERE, 'expectations.json'), JSON.stringify(expectations, null, 2) + '\n');
console.log(`wrote expectations for ${Object.keys(documents).length} documents`);

if (disagreements.length) {
  console.error('\nCROSS-CHECK DISAGREEMENTS (investigate before trusting these values):');
  for (const d of disagreements) console.error(`  ${d}`);
  process.exit(2);
}
console.log('page counts agree with poppler where it could read the file');
