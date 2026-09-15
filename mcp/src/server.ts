/**
 * An MCP server for PdfiumKit: many documents by id, the shared agent tools from pdfiumkit-ai,
 * and opening, closing and saving files. Spec: docs/superpowers/specs/2026-09-15-agent-tools-design.md.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PdfDocument } from '@pdfiumkit/web';
import { agentTools, PdfAgentError, PdfAgentSession, type PdfiumAIOptions } from 'pdfiumkit-ai';

interface OpenDocument {
  readonly session: PdfAgentSession;
  readonly path: string;
}

type Args = Record<string, unknown>;

interface ServerTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  readonly readOnly: boolean;
  readonly destructive: boolean;
  run(args: Args): Promise<unknown>;
}

const DOCUMENT_ID = { documentId: { type: 'string', description: 'From open_document.' } };

export function createPdfiumKitServer(options: PdfiumAIOptions = {}): Server {
  const documents = new Map<string, OpenDocument>();
  let next = 1;

  const documentOf = (args: Args): OpenDocument => {
    const id = args.documentId;
    const open = typeof id === 'string' ? documents.get(id) : undefined;
    if (!open) throw new PdfAgentError(`no open document ${String(id)}; call open_document first`);
    return open;
  };

  const tools: ServerTool[] = [
    {
      name: 'open_document',
      description: 'Opens a PDF file and returns a documentId for the other tools.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, password: { type: 'string' } }, required: ['path'] },
      readOnly: true,
      destructive: false,
      async run(args) {
        if (typeof args.path !== 'string') throw new PdfAgentError('path must be a string');
        const path = realpathSync(resolve(args.path));
        const document = await PdfDocument.open(new Uint8Array(readFileSync(path)),
          typeof args.password === 'string' ? args.password : undefined);
        const documentId = `doc-${next++}`;
        documents.set(documentId, { session: new PdfAgentSession(document, options), path });
        return { documentId, pageCount: await document.pageCount() };
      },
    },
    {
      name: 'close_document',
      description: 'Closes a document. Unsaved changes are lost.',
      inputSchema: { type: 'object', properties: DOCUMENT_ID, required: ['documentId'] },
      readOnly: true,
      destructive: false,
      async run(args) {
        const open = documentOf(args);
        documents.delete(args.documentId as string);
        await open.session.document.close();
        return { closed: true };
      },
    },
    {
      name: 'save_document',
      description: 'Saves the document, with any applied proposals, to a new file. Never overwrites the file it was opened from; an existing file is only replaced with overwrite: true.',
      inputSchema: {
        type: 'object',
        properties: { ...DOCUMENT_ID, outputPath: { type: 'string' }, overwrite: { type: 'boolean' } },
        required: ['documentId', 'outputPath'],
      },
      readOnly: false,
      destructive: true,
      async run(args) {
        const open = documentOf(args);
        if (typeof args.outputPath !== 'string') throw new PdfAgentError('outputPath must be a string');
        const output = resolve(args.outputPath);
        if (existsSync(output) && realpathSync(output) === open.path) {
          throw new PdfAgentError('refusing to overwrite the file the document was opened from');
        }
        if (existsSync(output) && args.overwrite !== true) throw new PdfAgentError(`${output} exists; pass overwrite: true to replace it`);
        const bytes = await open.session.document.toBytes('full');
        writeFileSync(output, bytes);
        return { path: output, bytes: bytes.length };
      },
    },
    ...agentTools.map((tool): ServerTool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: { ...DOCUMENT_ID, ...tool.inputSchema.properties },
        required: ['documentId', ...(tool.inputSchema.required ?? [])],
      },
      readOnly: tool.readOnly,
      destructive: !tool.readOnly,
      run: (args) => tool.run(documentOf(args).session, args),
    })),
  ];

  const server = new Server({ name: 'pdfiumkit', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema,
      annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) return { content: [{ type: 'text', text: `unknown tool ${request.params.name}` }], isError: true };
    try {
      const result = await tool.run(request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}
