/**
 * An agent's side of the MCP server: what a client such as Claude Desktop does when it
 * works on a PDF. Reading is free; every change is a proposal the user accepts first.
 *
 *   node mcp-client.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../../mcp/dist/main.js', import.meta.url));
const pdf = fileURLToPath(new URL('sample.pdf', import.meta.url));
const out = fileURLToPath(new URL('redacted.pdf', import.meta.url));

const agent = new Client({ name: 'pdfcora-sample', version: '0' });
// A real client starts the server the same way, from its own configuration file.
await agent.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));

const call = async (name, args) => {
  const result = await agent.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const { tools } = await agent.listTools();
console.log('Tools:', tools.map((t) => t.name).join(', '), '\n');

const { documentId, pageCount } = await call('open_document', { path: pdf });
console.log(`Opened ${pageCount} page(s) as ${documentId}`);

// Reading tools are marked read-only, so an agent may use them without asking.
const { matches } = await call('search', { documentId, query: 'IBAN' });
console.log(`"IBAN" appears ${matches.length} time(s)`);

// A proposal tool changes nothing. Its items are what the user sees.
const proposals = await call('propose_redactions', { documentId });
console.log(`\n${proposals.notice}`);
for (const item of proposals.items) console.log(`  ${item.id}  ${item.category}: ${item.text}`);

// The user accepted these two. Passing any other id is an error, and nothing changes.
const accepted = proposals.items.slice(0, 2).map((i) => i.id);
console.log(`\nApplying ${accepted.join(', ')}…`);
console.log(await call('apply_proposals', { documentId, proposalSetId: proposals.proposalSetId, acceptedIds: accepted }));

// Saving never writes over the file that was opened.
console.log(await call('save_document', { documentId, outputPath: out }));
console.log(`Wrote ${out}`);

// `undo` would put the document back as it was before the apply.
await call('close_document', { documentId });
await agent.close();
