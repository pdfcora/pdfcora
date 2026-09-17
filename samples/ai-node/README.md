# AI — Node

Propose redactions, apply only what a reviewer accepted, undo. Everything is in
`main.mjs`.

<!-- repo -->
```bash
(cd ../../web && npm install && npm run build)
(cd ../../web-ai && npm install && npm run build)
(cd ../../node && npm install && npm run build)
npm install && npm start
```
<!-- /repo -->
<!-- public
```bash
npm install && npm start
```
-->

Redaction suggestions are patterns, so they run with no model at all — which is what
makes them useful in a batch job. Summaries are not: with no provider configured the
sample prints what `availability()` reports rather than pretending, and the SDK never
downloads a model by itself. An app with a hosted model passes
`new PdfAI(pdf, { provider })`, and document text reaches that provider only because
the app configured one.

Nothing is applied until ids are passed to `apply`. Here a reviewer's decision is a
filter over the suggestions; in a real service it arrives from whatever approved them.
Redaction removes the content from the file rather than covering it, so `remaining`
reports what a search of the saved bytes can still find — it should be empty.
