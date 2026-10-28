# UI — web

The viewer component with a hand-picked toolbar, an app accent colour and a save handler.
Everything is in `main.js`.

<!-- repo -->
```bash
(cd ../../web && npm install && npm run build)   # builds web/dist
python3 -m http.server 8000 --directory ../..    # serve the repo root
open http://localhost:8000/samples/ui-web/
```

Serve the repo root rather than this folder: the page imports the SDK from `web/dist`.
<!-- /repo -->
<!-- public
```bash
python3 -m http.server 8000
open http://localhost:8000/
```
-->

`defaultToolbar` and `viewingToolbar` are ready-made; this sample lists its own items.
The viewer never writes a file — `onSave` hands the app the bytes.
