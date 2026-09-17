# UI — web

The viewer component with a hand-picked toolbar, an app accent colour and a save handler.
Everything is in `main.js`.

```bash
(cd ../../web && npm install && npm run build)   # builds web/dist
python3 -m http.server 8000 --directory ../..    # serve the repo root
open http://localhost:8000/samples/ui-web/
```

Serve the repo root rather than this folder: the page imports the SDK from `web/dist`.

`defaultToolbar` and `viewingToolbar` are ready-made; this sample lists its own items.
The viewer never writes a file — `onSave` hands the app the bytes.

Pages show a "PDFCora trial" watermark: the sample runs without a license key. The
commented line in `main.js` shows where a key issued for this site goes.
