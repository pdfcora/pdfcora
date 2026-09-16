# Samples

Four small apps per feature area, each doing one thing so the code is readable end to end.
They are separate from `ios/Demo` and `android/demo`, which show everything at once.

| | iOS | Android | Web |
| --- | --- | --- | --- |
| **Core** — open, text, search, form fields, render, save | `core-ios` | `core-android` | `core-web` |
| **AI** — summarise, propose redactions a person accepts | `ai-ios` | `ai-android` | `ai-web` |
| **UI** — the viewer component, custom toolbar and theme | `ui-ios` | `ui-android` | `ui-web` |
| **Agents** — MCP server and WebMCP | — | — | `agents-web` |

Agents are web and Node only: the MCP server is a Node process and WebMCP is a browser API.

Each folder has its own README with the commands to run it. All of them need PDFium first:

```bash
./scripts/fetch-vendor.sh      # from the repo root
```

Every sample runs without a license key, so its output carries the "PdfiumKit trial"
watermark; each README says where a key goes.
