# pdfcora-mcp

An MCP server that gives AI agents PDFCora's PDF tools: read text, search, list form fields,
read a page's accessible structure — and change documents only through proposals the user
accepts (redactions, form values, fields for flat forms, alt text), with undo, saving to a new file.

```bash
cd web && npm ci && npm run build && cd ../web-ai && npm ci && npm run build && cd ../mcp && npm ci && npm run build
```

Configure it in an MCP client, for example:

```json
{ "mcpServers": { "pdfcora": { "command": "node", "args": ["/path/to/mcp/dist/main.js"],
  "env": { "PDFCORA_LICENSE_KEY": "pk1...." } } } }
```

Without a license key, saved documents carry the trial watermark.

Tools: `open_document`, `close_document`, `save_document`, `document_info`, `get_text`, `search`,
`list_form_fields`, `get_page_structure`, `propose_redactions`, `propose_form_values`,
`detect_form_fields`, `propose_alt_text`, `apply_proposals`, `undo`. `apply_proposals`, `undo` and
`save_document` are marked destructive; the proposal tools change nothing. The same tools are
available to a browser agent through WebMCP with `registerWebMcpTools` from `@pdfcora/web-ai`.
