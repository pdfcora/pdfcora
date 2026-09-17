# Core — web

The core API with no UI: open a PDF, read its facts, get page text, search, list form
fields, render a page to a canvas, save. Everything is in `main.js`.

<!-- repo -->
```bash
(cd ../../web && npm install && npm run build)   # builds web/dist
python3 -m http.server 8000 --directory ../..    # serve the repo root
open http://localhost:8000/samples/core-web/
```
<!-- /repo -->
<!-- public
```bash
python3 -m http.server 8000
open http://localhost:8000/
```
-->

Serve the repo root rather than this folder: the page imports the SDK from `web/dist`.
