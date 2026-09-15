# PdfiumKit — Agent Tools (MCP and WebMCP) Design

Date: 2026-09-15
Status: Implemented 2026-09-16
Implements: "MCP / WebMCP tools for agents" of `2026-09-13-pdfiumkit-ai-requirements.md` §14

## 1. Purpose

Let an AI agent work with a PDF through PdfiumKit: read it freely, and change it only through
proposals that a person accepts (HIL-1), with undo (HIL-2).

Success criteria:

- One set of tool definitions serves both an MCP server (Node, stdio) and WebMCP in a web page.
- An MCP client can open a document, read text, search, list fields, get a page's accessible
  structure, propose redactions, apply only the ids it passes, undo, and save to a new file —
  never over the original.
- A page that calls `registerWebMcpTools` exposes the same tools to the browser's agent when
  `navigator.modelContext` exists, and does nothing otherwise.

## 2. Decisions

| Question | Decision |
| --- | --- |
| Where definitions live | `pdfiumkit-ai` (web): `agentTools` and `PdfAgentSession`, no MCP dependency |
| MCP server | New package `mcp/` (`pdfiumkit-mcp`), depending on `@modelcontextprotocol/sdk`, stdio transport, many documents by id |
| WebMCP | `registerWebMcpTools(session)` in `pdfiumkit-ai`, one document, feature-detected. Chrome 152 exposes `document.modelContext.registerTool(tool, { signal })` behind `--enable-blink-features=WebMCP`; the explainer's `navigator.modelContext` shape is accepted too |
| Writes | Every change is a proposal set first; `apply_proposals` takes the accepted ids; its description tells the agent to pass only ids the user accepted, and MCP annotations mark it destructive |
| Model inside tools | The agent is the model: tools run patterns and rules only, unless the host configured a provider for the session |
| Saving | MCP only, to a path that must differ from the opened file; WebMCP leaves saving to the page |

## 3. Tools

Read-only (`readOnlyHint`):

| Tool | Input | Result |
| --- | --- | --- |
| `document_info` | — | page count, metadata, tagged, field count, signature count |
| `get_text` | `from?`, `to?` (page indices) | `[{ pageIndex, text }]`, at most 100 000 characters, then `truncated: true` |
| `search` | `query`, `caseSensitive?` | `[{ pageIndex, start, length, context }]`, at most 200 |
| `list_form_fields` | — | `[{ pageIndex, annotationIndex, name, tooltip, kind, value }]` |
| `get_page_structure` | `pageIndex` | the page's accessible content |

Proposals (read-only themselves; each returns `{ proposalSetId, notice, items }`):

| Tool | Input | Items |
| --- | --- | --- |
| `propose_redactions` | `categories?` | `{ id, category, pageIndex, text }` |
| `propose_form_values` | `profile` | `{ id, pageIndex, fieldName, key, value }` |
| `detect_form_fields` | — | `{ id, pageIndex, kind, label }` |
| `propose_alt_text` | — | `{ id, pageIndex, kind, text, context }` |

Writes (`destructiveHint`):

| Tool | Input | Effect |
| --- | --- | --- |
| `apply_proposals` | `proposalSetId`, `acceptedIds`, `edits?` (alt text: id → text) | applies to the session's document; an unknown set or id is an error and changes nothing |
| `undo` | — | restores the document as it was before the last apply |

MCP server only: `open_document { path, password? } → { documentId, … }`, `close_document`,
`save_document { documentId, outputPath }` (refuses the opened path and existing files unless
`overwrite: true`). Every document tool on the server takes `documentId`.

Proposal sets are invalidated by `apply_proposals` and `undo` (they describe a document that no
longer exists); using one afterwards is an error.

## 4. Testing

- Session tests in `web-ai`: every tool on the shared fixtures; apply with accepted ids only;
  unknown ids change nothing; undo restores; stale proposal sets are refused.
- MCP server tests with the SDK's in-memory transport: list tools with annotations; open
  `pii.pdf`, propose redactions, apply two, save to a new file, and the redacted text is gone
  from the saved bytes while the original file is unchanged; saving over the original is refused.
- WebMCP: with a fake `navigator.modelContext`, the tools are provided and run; without it,
  registration returns false.
