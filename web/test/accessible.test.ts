import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, type PdfAccessibleNode, type PdfTagBlock } from '../dist/index.js';

const read = (path: string) => new Uint8Array(readFileSync(new URL(`../../conformance/${path}`, import.meta.url)));
const brief = (nodes: readonly PdfAccessibleNode[]): unknown[] => nodes.map((n) =>
  n.children.length ? { [n.role]: brief(n.children) } : `${n.role}${n.level ? n.level : ''}:${n.text}`);

describe('accessible content', () => {
  test('a tagged page reads as headings, paragraphs and figures in order', async () => {
    const document = await PdfDocument.open(read('alt-text/tagged.pdf'));
    assert.deepEqual(brief(await (await document.page(0)).accessibleContent()), [
      'heading1:Annual report 2026',
      'paragraph:Revenue grew in every region this year.',
      'figure:Bar chart of revenue by region',
      'paragraph:Figure 1: Revenue by region.',
      'figure:',
      'paragraph:Figure 2: The new office building in Berlin at dusk.',
      'figure:',
      'paragraph:Staff numbers rose to 120 people.',
    ]);
    const [heading] = await (await document.page(1)).accessibleContent();
    assert.equal(heading!.level, 2);
    assert.ok(heading!.bounds && heading!.bounds.top > 700);
  });

  test('lists nest their items', async () => {
    const expected = JSON.parse(readFileSync(new URL('../../conformance/remediation/untagged-expected.json', import.meta.url), 'utf8'));
    const next = new Map<number, number>();
    const blocks: PdfTagBlock[] = expected.map((b: { pageIndex: number; type: PdfTagBlock['type']; objectCount: number }) => {
      const start = next.get(b.pageIndex) ?? 0;
      next.set(b.pageIndex, start + b.objectCount);
      return { pageIndex: b.pageIndex, type: b.type, objectIndices: Array.from({ length: b.objectCount }, (_, i) => start + i) };
    });
    const tagged = await (await PdfDocument.open(read('remediation/untagged.pdf'))).tagContent(blocks, { title: 'T', language: 'en' });
    assert.deepEqual(brief(await (await tagged.page(0)).accessibleContent()).slice(0, 5), [
      'heading1:Quarterly newsletter',
      'paragraph:Welcome to the autumn issue. This quarter we opened two offices and welcomed forty new colleagues.',
      'heading2:Highlights',
      { list: ['listItem:• A new office in Berlin', 'listItem:• A new office in Madrid', 'listItem:• The staff survey results'] },
      'paragraph:The photo below shows the Berlin office.',
    ]);
  });

  test('an untagged page is one paragraph; form fields follow with their labels', async () => {
    const hello = await PdfDocument.open(read('corpus/hello_world.pdf'));
    const nodes = await (await hello.page(0)).accessibleContent();
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]!.role, 'paragraph');
    assert.match(nodes[0]!.text, /Hello, world!/);

    const form = await PdfDocument.open(read('corpus/text_form.pdf'));
    const fields = (await (await form.page(0)).accessibleContent()).filter((n) => n.role === 'formField');
    assert.equal(fields.length, 1);
    assert.equal(fields[0]!.text, 'Text Box');
  });
});
