import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPdfiumKitServer } from '../dist/server.js';

const PII = new URL('../../conformance/redaction/pii.pdf', import.meta.url).pathname;

async function client(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createPdfiumKitServer().connect(serverTransport);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(clientTransport);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = await c.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { error: result.isError === true, value: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) };
}

describe('pdfiumkit MCP server', () => {
  test('lists the tools with read-only and destructive hints', async () => {
    const { tools } = await (await client()).listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['open_document', 'get_text', 'search', 'list_form_fields', 'propose_redactions', 'apply_proposals', 'undo', 'save_document']) {
      assert.ok(byName.has(name), name);
    }
    assert.equal(byName.get('get_text')!.annotations?.readOnlyHint, true);
    assert.equal(byName.get('apply_proposals')!.annotations?.destructiveHint, true);
    assert.ok((byName.get('search')!.inputSchema.required as string[]).includes('documentId'));
  });

  test('open, propose, apply accepted ids, save to a new file; the original is untouched', async () => {
    const c = await client();
    const original = readFileSync(PII);
    const { value: opened } = await call(c, 'open_document', { path: PII });
    const documentId = opened.documentId;
    assert.equal(opened.pageCount, 2);

    const { value: found } = await call(c, 'search', { documentId, query: 'anna.schmidt@example.com' });
    assert.equal(found.matches.length, 1);

    const { value: proposals } = await call(c, 'propose_redactions', { documentId, categories: ['email', 'iban'] });
    const emails = proposals.items.filter((i: { category: string }) => i.category === 'email');
    await call(c, 'apply_proposals', { documentId, proposalSetId: proposals.proposalSetId, acceptedIds: emails.map((i: { id: string }) => i.id) });

    const dir = mkdtempSync(join(tmpdir(), 'pdfiumkit-mcp-'));
    const output = join(dir, 'redacted.pdf');
    const { value: saved } = await call(c, 'save_document', { documentId, outputPath: output });
    assert.equal(saved.path, output);
    const bytes = readFileSync(output).toString('latin1');
    assert.ok(!bytes.includes('anna.schmidt@example.com'), 'the accepted redaction left the saved bytes');
    assert.deepEqual(readFileSync(PII), original, 'the opened file is unchanged');

    const { value: again } = await call(c, 'open_document', { path: output });
    const { value: text } = await call(c, 'get_text', { documentId: again.documentId });
    assert.ok(text.pages.some((p: { text: string }) => p.text.includes('GB29 NWBK 6016 1331 9268 19')), 'the IBAN was not accepted');
  });

  test('saving over the opened file or an existing one is refused; unknown documents are errors', async () => {
    const c = await client();
    const { value: opened } = await call(c, 'open_document', { path: PII });
    const overOriginal = await call(c, 'save_document', { documentId: opened.documentId, outputPath: PII, overwrite: true });
    assert.equal(overOriginal.error, true);
    assert.match(overOriginal.value, /refusing to overwrite/);

    const dir = mkdtempSync(join(tmpdir(), 'pdfiumkit-mcp-'));
    const output = join(dir, 'copy.pdf');
    await call(c, 'save_document', { documentId: opened.documentId, outputPath: output });
    assert.match((await call(c, 'save_document', { documentId: opened.documentId, outputPath: output })).value, /exists/);
    assert.equal((await call(c, 'save_document', { documentId: opened.documentId, outputPath: output, overwrite: true })).error, false);

    assert.match((await call(c, 'get_text', { documentId: 'doc-99' })).value, /no open document/);
  });
});
