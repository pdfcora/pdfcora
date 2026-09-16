import { configureEngine, PdfDocument } from '../../web/dist/index.js';
import { agentTools, PdfAgentSession, registerWebMcpTools } from '../../web-ai/dist/index.js';

configureEngine({
  factory: async (options) => (await import('../../web/vendor/pdfium.esm.js')).default(options),
  locateFile: (path) => (path.endsWith('.wasm') ? '../../web/vendor/pdfium.esm.wasm' : path),
});

const bytes = new Uint8Array(await (await fetch('sample.pdf')).arrayBuffer());
const pdf = await PdfDocument.open(bytes);

// A session is one document, its open proposals and its undo history.
const session = new PdfAgentSession(pdf);

// Offers the tools to the browser's own agent. Returns null where the browser has no
// WebMCP — Chrome 152 needs --enable-blink-features=WebMCP — so a page can say so
// rather than break.
const remove = registerWebMcpTools(session);
document.getElementById('registered').textContent = remove
  ? `This browser has WebMCP: ${agentTools.length} tools offered to its agent.`
  : 'This browser has no WebMCP, so no tools were offered. The buttons below still work.';

const run = async (name, args = {}) => {
  const tool = agentTools.find((t) => t.name === name);
  document.getElementById('out').textContent = JSON.stringify(await tool.run(session, args), null, 2);
};

document.getElementById('info').onclick = () => run('document_info');
document.getElementById('propose').onclick = () => run('propose_redactions');

// An app that closes the document should remove the tools with it: remove?.().
