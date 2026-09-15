/**
 * Tools for AI agents, shared by the MCP server (`pdfiumkit-mcp`) and WebMCP. Reading is free;
 * every change is a proposal set first, applied only with the ids a person accepted (HIL-1), and
 * undoable (HIL-2). Spec: docs/superpowers/specs/2026-09-15-agent-tools-design.md.
 */

import type { PdfDocument, PdfDocumentSnapshot } from '@pdfiumkit/web';
import { PdfiumAI, type PdfiumAIOptions } from '../index.js';
import type { PdfProfile } from '../forms/propose.js';
import type { PdfRedactionCategory } from '../redaction/suggest.js';

/** A JSON value a tool returns. */
export type PdfAgentResult = unknown;

export interface PdfAgentTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, unknown>; readonly required?: readonly string[] };
  /** Reads only; proposal tools count as read-only because they change nothing. */
  readonly readOnly: boolean;
  run(session: PdfAgentSession, args: Record<string, unknown>): Promise<PdfAgentResult>;
}

export class PdfAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfAgentError';
  }
}

interface ProposalSet {
  readonly apply: (ids: readonly string[], edits: Readonly<Record<string, string>>) => Promise<PdfDocument>;
  readonly ids: ReadonlySet<string>;
}

const TEXT_LIMIT = 100_000;
const SEARCH_LIMIT = 200;

/** One document an agent works on, with its open proposal sets and undo history. */
export class PdfAgentSession {
  #document: PdfDocument;
  #proposals = new Map<string, ProposalSet>();
  #history: PdfDocumentSnapshot[] = [];
  #next = 1;

  constructor(document: PdfDocument, private readonly options: PdfiumAIOptions = {}) {
    this.#document = document;
  }

  /** The document as it is now: applying and undoing replace it. */
  get document(): PdfDocument {
    return this.#document;
  }

  get ai(): PdfiumAI {
    return new PdfiumAI(this.#document, this.options);
  }

  /** Records a proposal set and returns its id. */
  offer(apply: ProposalSet['apply'], ids: readonly string[]): string {
    const id = `set-${this.#next++}`;
    this.#proposals.set(id, { apply, ids: new Set(ids) });
    return id;
  }

  async apply(setId: string, acceptedIds: readonly string[], edits: Readonly<Record<string, string>> = {}): Promise<number> {
    const set = this.#proposals.get(setId);
    if (!set) throw new PdfAgentError(`no open proposal set ${setId}; proposals end when the document changes`);
    const unknown = acceptedIds.find((id) => !set.ids.has(id));
    if (unknown !== undefined) throw new PdfAgentError(`proposal ${unknown} is not in ${setId}`);
    const snapshot = await this.#document.snapshot();
    this.#document = await set.apply(acceptedIds, edits);
    this.#history.push(snapshot);
    this.#proposals.clear();
    return acceptedIds.length;
  }

  async undo(): Promise<boolean> {
    const snapshot = this.#history.pop();
    if (!snapshot) return false;
    this.#document = await snapshot.open();
    this.#proposals.clear();
    return true;
  }
}

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new PdfAgentError(`${name} must be a string`);
  return value;
};
const int = (value: unknown, name: string): number => {
  if (!Number.isInteger(value)) throw new PdfAgentError(`${name} must be an integer`);
  return value as number;
};
const ids = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new PdfAgentError('acceptedIds must be an array of strings');
  return value as string[];
};

async function pageRange(session: PdfAgentSession, args: Record<string, unknown>) {
  const count = await session.document.pageCount();
  const from = args.from === undefined ? 0 : int(args.from, 'from');
  const to = args.to === undefined ? count - 1 : int(args.to, 'to');
  return { from: Math.max(0, from), to: Math.min(count - 1, to) };
}

export const agentTools: readonly PdfAgentTool[] = [
  {
    name: 'document_info',
    description: 'Page count, metadata, whether the PDF is tagged, and how many form fields and signatures it has.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    async run(session) {
      const d = session.document;
      const pageCount = await d.pageCount();
      let fields = 0;
      for (let p = 0; p < pageCount; p++) fields += (await (await d.page(p)).formFields()).length;
      return { pageCount, metadata: await d.metadata(), tagged: await d.isTagged(), formFields: fields, signatures: (await d.signatures()).length };
    },
  },
  {
    name: 'get_text',
    description: 'The text of a page range (page indices are 0-based and inclusive). Long documents are truncated at 100 000 characters.',
    inputSchema: { type: 'object', properties: { from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 } } },
    readOnly: true,
    async run(session, args) {
      const { from, to } = await pageRange(session, args);
      const pages: { pageIndex: number; text: string }[] = [];
      let total = 0;
      for (let pageIndex = from; pageIndex <= to; pageIndex++) {
        const text = await (await session.document.page(pageIndex)).text.string();
        if (total + text.length > TEXT_LIMIT) {
          pages.push({ pageIndex, text: text.slice(0, TEXT_LIMIT - total) });
          return { pages, truncated: true };
        }
        total += text.length;
        pages.push({ pageIndex, text });
      }
      return { pages, truncated: false };
    },
  },
  {
    name: 'search',
    description: 'Finds text in the document. Returns each match with its page and some surrounding text; at most 200.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, caseSensitive: { type: 'boolean' } }, required: ['query'] },
    readOnly: true,
    async run(session, args) {
      const query = str(args.query, 'query');
      const matches: { pageIndex: number; start: number; length: number; context: string }[] = [];
      const count = await session.document.pageCount();
      for (let pageIndex = 0; pageIndex < count && matches.length < SEARCH_LIMIT; pageIndex++) {
        const page = await session.document.page(pageIndex);
        const text = await page.text.string();
        for (const m of await page.text.search(query, { caseSensitive: args.caseSensitive === true })) {
          if (matches.length >= SEARCH_LIMIT) break;
          matches.push({ pageIndex, start: m.start, length: m.length,
            context: text.slice(Math.max(0, m.start - 40), m.start + m.length + 40).replace(/\s+/g, ' ') });
        }
      }
      return { matches };
    },
  },
  {
    name: 'list_form_fields',
    description: 'Every form field with its page, name, tooltip, kind and current value.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    async run(session) {
      const fields: unknown[] = [];
      const count = await session.document.pageCount();
      for (let pageIndex = 0; pageIndex < count; pageIndex++) {
        for (const f of await (await session.document.page(pageIndex)).formFields()) {
          fields.push({
            pageIndex, annotationIndex: f.annotationIndex, name: f.name ?? null, tooltip: f.alternateName ?? null, kind: f.kind,
            value: 'value' in f ? f.value : 'isChecked' in f ? f.isChecked : null,
          });
        }
      }
      return { fields };
    },
  },
  {
    name: 'get_page_structure',
    description: "A page's content as a screen reader hears it: headings, paragraphs, lists, figures with alternate text, tables, form fields.",
    inputSchema: { type: 'object', properties: { pageIndex: { type: 'integer', minimum: 0 } }, required: ['pageIndex'] },
    readOnly: true,
    async run(session, args) {
      return { nodes: await (await session.document.page(int(args.pageIndex, 'pageIndex'))).accessibleContent() };
    },
  },
  {
    name: 'propose_redactions',
    description: 'Proposes personal data to redact (IBANs, emails, phone numbers, cards, dates, URLs, IP addresses). Changes nothing; show the items to the user and apply only those they accept.',
    inputSchema: { type: 'object', properties: { categories: { type: 'array', items: { type: 'string' } } } },
    readOnly: true,
    async run(session, args) {
      const categories = Array.isArray(args.categories) ? (args.categories as PdfRedactionCategory[]) : undefined;
      const review = await session.ai.redactions.suggest(categories ? { categories } : {});
      const document = session.document;
      const proposalSetId = session.offer(async (accepted) => {
        await review.apply(accepted);
        return document;
      }, review.suggestions.map((s) => s.id));
      return { proposalSetId, notice: review.notice,
        items: review.suggestions.map((s) => ({ id: s.id, category: s.category, pageIndex: s.pageIndex, text: s.text })) };
    },
  },
  {
    name: 'propose_form_values',
    description: "Proposes values for the document's form fields from a profile (givenName, familyName, fullName, dateOfBirth, email, phone, street, postalCode, city, country, iban, company). Changes nothing.",
    inputSchema: { type: 'object', properties: { profile: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['profile'] },
    readOnly: true,
    async run(session, args) {
      if (typeof args.profile !== 'object' || args.profile === null) throw new PdfAgentError('profile must be an object');
      const proposals = await session.ai.forms.propose(args.profile as PdfProfile);
      const document = session.document;
      const proposalSetId = session.offer(async (accepted) => {
        await proposals.apply(accepted);
        return document;
      }, proposals.items.map((p) => p.id));
      return { proposalSetId, notice: proposals.notice,
        items: proposals.items.map((p) => ({ id: p.id, pageIndex: p.pageIndex, fieldName: p.fieldName ?? null, key: p.key, value: p.value })) };
    },
  },
  {
    name: 'detect_form_fields',
    description: 'For a flat PDF without form fields, proposes text fields and checkboxes where its lines, boxes and underscores are. Changes nothing.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    async run(session) {
      const detected = await session.ai.forms.detect();
      const proposalSetId = session.offer((accepted) => detected.apply(accepted), detected.items.map((i) => i.id));
      return { proposalSetId, notice: detected.notice,
        items: detected.items.map((i) => ({ id: i.id, pageIndex: i.pageIndex, kind: i.kind, label: i.label })) };
    },
  },
  {
    name: 'propose_alt_text',
    description: 'Lists figures in a tagged PDF that lack alternate text, with proposed descriptions where a model is configured and the nearby text as context. Changes nothing; pass edited descriptions in edits when applying.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    async run(session) {
      const review = await session.ai.altText.suggest();
      const proposalSetId = session.offer((accepted, edits) =>
        review.apply(accepted.map((id) => (edits[id] !== undefined ? { id, text: edits[id] } : { id }))), review.items.map((i) => i.id));
      return { proposalSetId, notice: review.notice, untagged: review.untagged,
        items: review.items.map((i) => ({ id: i.id, pageIndex: i.pageIndex, kind: i.kind, text: i.text, context: i.context })) };
    },
  },
  {
    name: 'apply_proposals',
    description: 'Applies proposals from a proposal set. Pass ONLY the ids the user explicitly accepted after seeing them. Undo with the undo tool.',
    inputSchema: {
      type: 'object',
      properties: {
        proposalSetId: { type: 'string' },
        acceptedIds: { type: 'array', items: { type: 'string' } },
        edits: { type: 'object', additionalProperties: { type: 'string' }, description: 'Alt text only: id → the description to write instead of the proposal.' },
      },
      required: ['proposalSetId', 'acceptedIds'],
    },
    readOnly: false,
    async run(session, args) {
      const edits = (typeof args.edits === 'object' && args.edits !== null ? args.edits : {}) as Record<string, string>;
      const applied = await session.apply(str(args.proposalSetId, 'proposalSetId'), ids(args.acceptedIds), edits);
      return { applied };
    },
  },
  {
    name: 'undo',
    description: 'Restores the document as it was before the last apply_proposals.',
    inputSchema: { type: 'object', properties: {} },
    readOnly: false,
    async run(session) {
      return { undone: await session.undo() };
    },
  },
];
