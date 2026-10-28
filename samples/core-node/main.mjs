/**
 * The core API on a server: open a PDF, read its facts, get page text, search, list form
 * fields, write a page out as a PNG, save.
 *
 *   node main.mjs
 */
import { writeFile } from 'node:fs/promises';
import { openFile, renderPng, saveFile } from '@pdfcora/node';

// Nothing to configure: unlike the browser, Node finds the engine's WASM itself.
const pdf = await openFile('sample.pdf');

const metadata = await pdf.metadata();
console.log('Pages          ', await pdf.pageCount());
console.log('Title          ', metadata.title || '(none)');
console.log('Signatures     ', (await pdf.signatures()).length);

const page = await pdf.page(0);

// Text, search and form fields all come from the page.
const text = await page.text.string();
console.log('First line     ', text.split('\n')[0]);
console.log('Matches "the"  ', (await page.text.search('the')).length);
console.log('Form fields    ', (await page.formFields()).length);

// renderPng hands back encoded bytes; the PNG encoder is node:zlib, so there is no
// image dependency to install.
await writeFile('page-1.png', await renderPng(page, { width: 900 }));
console.log('Wrote          ', 'page-1.png');

// saveFile writes the document straight to disk and returns how many bytes it wrote.
console.log('Saved          ', `${await saveFile(pdf, 'out.pdf')} bytes to out.pdf`);

await pdf.close();
