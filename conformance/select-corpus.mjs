import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = '/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources';
const MAX_BYTES = 200 * 1024;

const SELECTION = [
  ['hello_world.pdf', 'basic'],
  ['rectangles.pdf', 'basic'],
  ['many_rectangles.pdf', 'basic'],
  ['combobox_form.pdf', 'form'],
  ['listbox_form.pdf', 'form'],
  ['text_form.pdf', 'form'],
  ['click_form.pdf', 'form'],
  ['encrypted_hello_world_r2.pdf', 'encrypted'],
  ['annotation_highlight_long_content.pdf', 'annotation'],
  ['annots_action_handling.pdf', 'annotation'],
  ['annotation_stamp_with_ap.pdf', 'annotation'],
  ['text_font.pdf', 'text'],
  ['find_text_consecutive.pdf', 'text'],
  ['hebrew_mirrored.pdf', 'text'],
  ['tagged_actual_text.pdf', 'text'],
  ['hello_world_2_pages_split_streams.pdf', 'basic'],
  ['embedded_attachments.pdf', 'basic'],
  ['bug_455199.pdf', 'regression'],
  ['bug_707673.pdf', 'regression'],
];

mkdirSync(join(HERE, 'corpus'), { recursive: true });
const files = [];
const skipped = [];

for (const [name, category] of SELECTION) {
  const src = join(SRC, name);
  if (!existsSync(src)) { skipped.push(`${name} (not found)`); continue; }
  if (statSync(src).size > MAX_BYTES) { skipped.push(`${name} (too large)`); continue; }
  copyFileSync(src, join(HERE, 'corpus', name));
  files.push({ name, category });
}

writeFileSync(
  join(HERE, 'corpus.json'),
  JSON.stringify({
    source: 'PDFium testing/resources @ chromium/7243',
    license: 'BSD-3-Clause (see NOTICE.md)',
    files,
  }, null, 2) + '\n'
);

console.log(`selected ${files.length} files`);
if (skipped.length) console.log(`skipped:\n  ${skipped.join('\n  ')}`);
