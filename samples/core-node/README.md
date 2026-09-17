# Core — Node

The core API with no UI: open a PDF, read its facts, get page text, search, list form
fields, write a page out as a PNG, save. Everything is in `main.mjs`.

```bash
(cd ../../web && npm install && npm run build)    # the engine the Node package wraps
(cd ../../node && npm install && npm run build)
npm install && npm start
```

Nothing to configure and nothing to compile: the WebAssembly engine ships inside the
package and Node finds it itself.

Set `PDFCORA_LICENSE_KEY` before running to drop the trial watermark from `page-1.png`.
