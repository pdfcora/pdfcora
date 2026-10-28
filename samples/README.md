# Samples

<!-- repo -->
Small apps, each doing one thing so the code is readable end to end. They are separate
from `ios/Demo` and `android/demo`, which show everything at once.
<!-- /repo -->
<!-- public
Small apps for the [PDFCora](https://pdfcora.com) PDF SDK, each doing one thing so the
code is readable end to end. API reference: https://pdfcora.com/developers.html
-->

| | iOS | Android | Web | Node | Java |
| --- | --- | --- | --- | --- | --- |
| **Core** — open, text, search, form fields, render, save | `core-ios` | `core-android` | `core-web` | `core-node` | `core-java` |
| **AI** — summarise, propose redactions a person accepts | `ai-ios` | `ai-android` | `ai-web` | `ai-node` | — |
| **UI** — the viewer component, custom toolbar and theme | `ui-ios` | `ui-android` | `ui-web` | — | — |
| **Agents** — MCP server and WebMCP | — | — | `agents-web` | `agents-web` | — |
| **Pipeline** — tag for accessibility, sign, countersign | — | — | — | — | `pipeline-java` |
| **DOCX** — open a Word file as a PDF, render, save | — | — | — | — | `docx-java` |

A server has no screen, so there is no UI sample for Node or Java, and the Java SDK has
no AI package yet. `agents-web` covers both of its columns: its MCP client is a Node
process talking to the `pdfcora-mcp` server, and the same tools reach a browser agent
through WebMCP.

<!-- repo -->
Each folder has its own README with the commands to run it. All of them need PDFium
first:

```bash
./scripts/fetch-vendor.sh      # from the repo root
```

The Java samples also need `./scripts/build-jni.sh`, which builds the native engine the
jar carries.
<!-- /repo -->
<!-- public
Each folder has its own README with the command to run it. The SDK comes from the
package registries: Swift Package Manager, Maven Central and npm.
-->

The iOS, Android, web and Node samples run without a license key, so their output
carries the "PDFCora trial" watermark; each README says where a key goes. The Java SDK
has no licensing module yet, so its samples produce unwatermarked output.
