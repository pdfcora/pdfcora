/**
 * Copies the PDFium artifacts into the package so they ship with it.
 *
 * The repo keeps them in a gitignored top-level vendor/; an installed package cannot
 * reach that, so the files must live inside the package directory. Run before packing
 * and before tests.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const SOURCE = join(PKG, '..', 'vendor', 'web');
const DEST = join(PKG, 'vendor');

const FILES = ['pdfium.js', 'pdfium.wasm', 'pdfium.esm.js', 'pdfium.esm.wasm'];

if (!existsSync(SOURCE)) {
  console.error(`missing ${SOURCE} — run ./scripts/fetch-vendor.sh from the repo root`);
  process.exit(1);
}
mkdirSync(DEST, { recursive: true });
for (const name of FILES) {
  copyFileSync(join(SOURCE, name), join(DEST, name));
}
// The glue is CommonJS; without this the package's "type": "module" misreads it.
copyFileSync(join(HERE, 'vendor-package.json'), join(DEST, 'package.json'));
console.log(`staged ${FILES.length} artifacts into web/vendor/`);
