# @pdfcora/web-ai

AI features for [`@pdfcora/web`](https://www.npmjs.com/package/@pdfcora/web): answers
with citations, summaries, redaction and form-fill proposals, alt text, accessibility
remediation, document diff, and tools for AI agents (MCP and WebMCP).

```bash
npm install @pdfcora/web @pdfcora/web-ai
```

Documentation: https://pdfcora.com/ai.html

## Use

```js
import { PdfDocument } from '@pdfcora/web';
import { PdfAI } from '@pdfcora/web-ai';

const pdf = await PdfDocument.open(bytes);
const ai = new PdfAI(pdf);

const result = await ai.summaries.summarize({ style: 'keyPoints' });
if ('value' in result) console.log(result.value.text);
else console.log('unavailable:', result.kind);

const review = await ai.redactions.suggest();   // proposals; nothing is applied yet
```

With no provider configured, the SDK uses what the browser offers (Chrome's built-in
models) and its own patterns, and document text never leaves the device. An app with a
hosted model passes `new PdfAI(pdf, { provider })`.

Every change is a proposal a person accepts, and it can be undone.

## Licensing

See `LICENSE.md`. Without a key, output carries a "PDFCora trial" watermark.
