# Agents — MCP and WebMCP

Two ways an AI agent uses PdfiumKit. Reading is free; every change is a proposal the user
accepts, and it can be undone.

## An MCP client (Node)

`mcp-client.mjs` is what a client such as Claude Desktop does: list the tools, open a PDF,
search it, ask for redaction proposals, apply the two the user accepted, save to a **new**
file.

```bash
(cd ../../web && npm install && npm run build)
(cd ../../web-ai && npm install && npm run build)
(cd ../../mcp && npm install && npm run build)
npm install && node mcp-client.mjs
```

To wire the server into a real client instead:

```json
{ "mcpServers": { "pdfiumkit": { "command": "node", "args": ["/path/to/mcp/dist/main.js" ] } } }
```

## WebMCP (browser)

`index.html` offers the same tools to the browser's own agent for one open document, and
runs two of them from buttons so the page works either way.

```bash
python3 -m http.server 8000 --directory ../..
open http://localhost:8000/samples/agents-web/
```

Chrome 152 needs `--enable-blink-features=WebMCP`; without it `registerWebMcpTools`
returns `null` and the page says so.
