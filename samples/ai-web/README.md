# AI — web

Summarise a document and propose redactions a person accepts, with undo. Everything is in
`main.js`.

<!-- repo -->
```bash
(cd ../../web && npm install && npm run build)
(cd ../../web-ai && npm install && npm run build)
python3 -m http.server 8000 --directory ../..
open http://localhost:8000/samples/ai-web/
```
<!-- /repo -->
<!-- public
```bash
python3 -m http.server 8000
open http://localhost:8000/
```
-->

The summary uses Chrome's built-in `Summarizer` where the browser has it; the page shows
what `availability()` reports otherwise, and never downloads a model by itself — that is
`ai.summaries.prepare()`, called from a user gesture. An app with a hosted model passes
`new PdfAI(pdf, { provider })` instead; document text reaches a provider only because
the app configured one.

Redaction suggestions are patterns here, so they work with no model at all. Nothing is
changed until the ticked items are applied, and the notice is shown with them, as the SDK
requires.
