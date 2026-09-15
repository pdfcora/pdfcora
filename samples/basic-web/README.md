# Basic viewer — web

The smallest web integration: open a bundled PDF in `PdfViewerElement` with its default
toolbar. Everything is in `main.js`.

```bash
(cd ../../web && npm install && npm run build)   # builds web/dist
python3 -m http.server 8000 --directory ../..    # serve the repo root
open http://localhost:8000/samples/basic-web/
```

Serve the repo root rather than this folder: the page imports the SDK from `web/dist`.
