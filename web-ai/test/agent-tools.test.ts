import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfiumkit/web';
import { agentTools, PdfAgentSession, registerWebMcpTools } from '../dist/index.js';

const read = (path: string) => new Uint8Array(readFileSync(new URL(`../../conformance/${path}`, import.meta.url)));
const tool = (name: string) => agentTools.find((t) => t.name === name)!;
const run = async (session: PdfAgentSession, name: string, args: Record<string, unknown> = {}) =>
  tool(name).run(session, args) as Promise<Record<string, any>>;

describe('agent tools', () => {
  test('read-only tools report the document', async () => {
    const session = new PdfAgentSession(await PdfDocument.open(read('forms/forms.pdf')));
    const info = await run(session, 'document_info');
    assert.equal(info.pageCount, 2);
    assert.equal(info.formFields, 27);
    const text = await run(session, 'get_text', { from: 1, to: 1 });
    assert.equal(text.pages.length, 1);
    assert.match(text.pages[0].text, /Vorname/);
    const found = await run(session, 'search', { query: 'IBAN' });
    assert.deepEqual(found.matches.map((m: { pageIndex: number }) => m.pageIndex), [0, 1]);
    const fields = await run(session, 'list_form_fields');
    assert.equal(fields.fields.length, 27);
    const structure = await run(new PdfAgentSession(await PdfDocument.open(read('alt-text/tagged.pdf'))), 'get_page_structure', { pageIndex: 0 });
    assert.equal(structure.nodes[0].text, 'Annual report 2026');
    assert.deepEqual(agentTools.filter((t) => !t.readOnly).map((t) => t.name), ['apply_proposals', 'undo']);
  });

  test('redactions apply only the accepted ids, and undo restores the document', async () => {
    const session = new PdfAgentSession(await PdfDocument.open(read('redaction/pii.pdf')));
    const proposals = await run(session, 'propose_redactions', { categories: ['email'] });
    assert.match(proposals.notice, /incomplete/);
    const [first, second] = proposals.items;
    await assert.rejects(tool('apply_proposals').run(session, { proposalSetId: proposals.proposalSetId, acceptedIds: ['nope'] }), /not in/);

    assert.deepEqual(await run(session, 'apply_proposals', { proposalSetId: proposals.proposalSetId, acceptedIds: [first.id] }), { applied: 1 });
    const text = async () => (await (await session.document.page(0)).text.string()) + (await (await session.document.page(1)).text.string());
    assert.ok(!(await text()).includes(first.text));
    assert.ok((await text()).includes(second.text), 'a proposal not accepted is left alone');
    await assert.rejects(tool('apply_proposals').run(session, { proposalSetId: proposals.proposalSetId, acceptedIds: [second.id] }), /no open proposal set/);

    assert.deepEqual(await run(session, 'undo'), { undone: true });
    assert.ok((await text()).includes(first.text));
    assert.deepEqual(await run(session, 'undo'), { undone: false });
  });

  test('flat form fields and alt text go through the same proposals', async () => {
    const flat = new PdfAgentSession(await PdfDocument.open(read('forms/flat.pdf')));
    const detected = await run(flat, 'detect_form_fields');
    await run(flat, 'apply_proposals', { proposalSetId: detected.proposalSetId, acceptedIds: [detected.items[0].id] });
    assert.equal((await run(flat, 'list_form_fields')).fields[0].name, 'First name');

    const tagged = new PdfAgentSession(await PdfDocument.open(read('alt-text/tagged.pdf')));
    const alt = await run(tagged, 'propose_alt_text');
    const photo = alt.items.find((i: { kind: string }) => i.kind === 'description');
    await run(tagged, 'apply_proposals', { proposalSetId: alt.proposalSetId, acceptedIds: [photo.id], edits: { [photo.id]: 'An office at dusk' } });
    const nodes = (await run(tagged, 'get_page_structure', { pageIndex: 0 })).nodes as { role: string; text: string }[];
    assert.ok(nodes.some((n) => n.role === 'figure' && n.text === 'An office at dusk'));
  });

  test('WebMCP registers the tools when the browser has it, and does nothing otherwise', async () => {
    const session = new PdfAgentSession(await PdfDocument.open(read('forms/forms.pdf')));
    assert.equal(registerWebMcpTools(session), null);

    const registered = new Map<string, { execute(input: object): Promise<{ content: { text: string }[] }> }>();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { modelContext: {
      registerTool(t: { name: string; execute(input: object): Promise<{ content: { text: string }[] }> }) {
        registered.set(t.name, t);
        return { unregister: () => registered.delete(t.name) };
      },
    } } });
    try {
      const unregister = registerWebMcpTools(session);
      assert.equal(registered.size, agentTools.length);
      const info = JSON.parse((await registered.get('pdf_document_info')!.execute({})).content[0]!.text);
      assert.equal(info.pageCount, 2);
      unregister!();
      assert.equal(registered.size, 0);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});
