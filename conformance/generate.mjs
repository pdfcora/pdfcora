import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPdfium } from '../tools/host/pdfium-host.mjs';
import { validateExpectations } from './validate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = 'chromium/7243';
const META_KEYS = ['Title', 'Author', 'Subject', 'Creator', 'Producer'];

/**
 * Signature expectations come from `pdfsig`, not from PDFium.
 *
 * The point of the contract is to catch a bug in our own reader, which a value read
 * back from the same engine cannot do. Returns null when pdfsig is unavailable, so the
 * generator still runs; the field is then simply absent.
 */
function pdfsigSignatures(path) {
  let out;
  try {
    out = execFileSync('pdfsig', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }

  const signatures = [];
  for (const block of out.split(/^Signature #\d+:$/m).slice(1)) {
    const subFilter = /- Signature Type:\s*(\S+)/.exec(block)?.[1];
    // pdfsig prints spans as [start - end]; a PDF /ByteRange is offset/length pairs.
    const ranges = [...block.matchAll(/\[(\d+)\s*-\s*(\d+)\]/g)]
      .flatMap(([, start, end]) => [Number(start), Number(end) - Number(start)]);
    signatures.push({
      subFilter,
      byteRange: ranges,
      coversWholeDocument: /- Total document signed/.test(block),
    });
  }
  return signatures;
}

function popplerPageCount(path) {
  try {
    const out = execFileSync('pdfinfo', [path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/^Pages:\s+(\d+)$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;   // encrypted or damaged files legitimately defeat pdfinfo
  }
}

/**
 * Whitespace stripped before hashing, by explicit codepoint.
 *
 * `\\s` is NOT portable: U+00A0 matches it in JavaScript but not in Java's
 * Character.isWhitespace, and ICU's definition differs again. Comparing hashes across
 * Swift, Kotlin, and TypeScript needs one set all three can reproduce exactly.
 */
const STRIPPED = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x2028, 0x2029, 0x202f, 0x3000,
]);

/**
 * PDFium emits layout-driven spacing that carries no meaning and varies with how each
 * binding trims the trailing terminator. The glyphs and their order are the contract.
 */
function normalizeText(text) {
  let out = '';
  for (const ch of text) {
    if (!STRIPPED.has(ch.codePointAt(0))) out += ch;
  }
  return out;
}

function textHash(text) {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
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
    const text = doc.text(i);
    const page = {
      width: Number(width.toFixed(2)),
      height: Number(height.toFixed(2)),
      charCount: doc.charCount(i),
    };
    const normalized = normalizeText(text);
    if (normalized) {
      page.textSha256 = textHash(text);
      // A short, human-readable anchor so a failure says what was expected.
      // Human-readable anchor so a failure message says what was expected.
      page.textContains = [text.replace(/\s+/g, ' ').trim().slice(0, 24)];
    }
    pages.push(page);
  }

  const metadata = {};
  for (const k of META_KEYS) {
    const v = doc.metadata(k);
    if (v) metadata[k] = v;
  }

  documents[name] = { category, opens: true, pageCount, pages };
  if (Object.keys(metadata).length) documents[name].metadata = metadata;

  const signatures = pdfsigSignatures(path);
  if (signatures && signatures.length) documents[name].signatures = signatures;

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
