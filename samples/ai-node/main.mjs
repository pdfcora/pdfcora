/**
 * The AI package on a server: propose redactions, apply only what a person accepted,
 * undo. A batch job has no user at a screen, so the "person" here is the reviewer whose
 * decision arrives as a list of ids.
 *
 *   node main.mjs
 */
import { openFile, saveFile } from '@pdfiumkit/node';
import { PdfiumAI } from '@pdfiumkit/web-ai';

let pdf = await openFile('sample.pdf');

// No provider is configured, so only the routes that need no model run: the redaction
// patterns below, and the rules behind form and alt-text proposals. An app with a
// hosted model passes `new PdfiumAI(pdf, { provider })`, and document text reaches that
// provider only because the app said so.
let ai = new PdfiumAI(pdf);

// A summary needs a model. On a server there is no browser to supply one, so this says
// so rather than pretending — and the SDK never downloads one by itself.
const availability = await ai.summaries.availability();
console.log('Summaries:', availability.kind,
  availability.reason ? `(${availability.reason})` : '');

// Suggesting changes nothing. The notice must be shown with the suggestions.
const review = await ai.redactions.suggest();
console.log(`\n${review.notice}\n`);
for (const s of review.suggestions) {
  console.log(`  ${s.category.padEnd(12)} page ${s.pageIndex + 1}  ${s.text}`);
}

// A reviewer accepted the bank details and email addresses. Passing ids rather than
// "apply everything" is the point: nothing a person did not choose is ever written.
const accepted = review.suggestions.filter((s) => s.category === 'iban' || s.category === 'email')
  .map((s) => s.id);
console.log(`\nApplying ${accepted.length} of ${review.suggestions.length}…`);

const applied = await review.apply(accepted);
// Redaction removes the content itself rather than covering it, so this counts what
// left the saved bytes. `remaining` is empty when nothing accepted survived.
console.log('  removed      ', `${applied.report.textObjects} text object(s), ` +
  `${applied.report.textObjectsSplit} rewritten, on page(s) ` +
  applied.report.pages.map((p) => p + 1).join(', '));
console.log('  still findable', applied.remaining.length);
console.log('  wrote        ', `${await saveFile(pdf, 'redacted.pdf')} bytes to redacted.pdf`);

// Every change can be undone, which reopens the document as it was.
pdf = await applied.undo();
ai = new PdfiumAI(pdf);
console.log('\nUndone; the original document is open again,',
  (await (await pdf.page(0)).text.string()).length, 'characters on page 1.');

await pdf.close();
