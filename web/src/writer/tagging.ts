/**
 * Writing a new structure tree for content PDFium has already marked.
 *
 * PDFium puts the marked-content ids into the page content; the tree that points at them
 * is dictionaries, which only this writer can create.
 */

import { appendUpdate } from './incremental.js';
import { listPages, readCatalog, readObject, refNumber } from './read.js';
import { nextObjectNumber, scanTrailer } from './scan.js';
import { entryOf, name, raw, ref, type PdfValue } from './values.js';
import { buildXref } from './xref.js';

export interface TaggedBlock {
  readonly pageIndex: number;
  readonly type: string;
  /** The marked-content ids PDFium gave this block's objects. */
  readonly mcids: readonly number[];
  readonly altText?: string;
}

export interface TagTree {
  /** In reading order, artifacts excluded. */
  readonly blocks: readonly TaggedBlock[];
  /** Marked-content ids used on each page. */
  readonly mcidCounts: readonly number[];
  readonly title: string;
  /** Written to /Lang; undefined keeps the Catalog's own. */
  readonly language?: string;
}

type Dictionary = Record<string, PdfValue>;

export async function writeTagTree(bytes: Uint8Array, tree: TagTree): Promise<Uint8Array> {
  const info = scanTrailer(bytes);
  const xref = await buildXref(bytes);
  const { number: catalogNumber, value: catalog } = await readCatalog(bytes);
  const pages = await listPages(bytes, xref, catalog);

  let next = nextObjectNumber(info);
  const allocate = () => next++;
  const rootNumber = allocate();
  const documentNumber = allocate();
  const metadataNumber = allocate();

  const objects = new Map<number, PdfValue>();
  const documentKids: PdfValue[] = [];
  const parents: (PdfValue | null)[][] = tree.mcidCounts.map((count) => Array(count).fill(null));

  let list: { number: number; kids: PdfValue[] } | undefined;
  for (const block of tree.blocks) {
    const page = pages[block.pageIndex]!;
    const holder = allocate();
    const content = { Pg: ref(page), K: [...block.mcids] };
    for (const id of block.mcids) parents[block.pageIndex]![id] = ref(holder);

    if (block.type !== 'LI') {
      list = undefined;
      objects.set(holder, {
        Type: name('StructElem'), S: name(block.type), P: ref(documentNumber), ...content,
        ...(block.altText ? { Alt: block.altText } : {}),
      });
      documentKids.push(ref(holder));
      continue;
    }
    if (!list) {
      list = { number: allocate(), kids: [] };
      documentKids.push(ref(list.number));
    }
    const item = allocate();
    list.kids.push(ref(item));
    objects.set(item, { Type: name('StructElem'), S: name('LI'), P: ref(list.number), K: [ref(holder)] });
    objects.set(holder, { Type: name('StructElem'), S: name('LBody'), P: ref(item), ...content });
    objects.set(list.number, { Type: name('StructElem'), S: name('L'), P: ref(documentNumber), K: list.kids });
  }

  const parentTree = allocate();
  objects.set(parentTree, { Nums: parents.flatMap((row, pageIndex) => [pageIndex, row.map((r) => r ?? null)]) });
  objects.set(documentNumber, { Type: name('StructElem'), S: name('Document'), P: ref(rootNumber), K: documentKids });
  objects.set(rootNumber, {
    Type: name('StructTreeRoot'), K: ref(documentNumber), ParentTree: ref(parentTree), ParentTreeNextKey: pages.length,
  });

  for (const [pageIndex, number] of pages.entries()) {
    const page = await readObject(bytes, xref, number);
    if (!isDictionary(page)) throw new Error(`tagging: page ${pageIndex} is unreadable`);
    objects.set(number, { ...page, StructParents: pageIndex, Tabs: name('S') });
  }

  const xmp = xmpPacket(tree.title);
  objects.set(metadataNumber, raw(concat([
    latin1(`<</Type /Metadata /Subtype /XML /Length ${utf8(xmp).length}>>\nstream\n`), utf8(xmp), latin1('\nendstream'),
  ])));

  const catalogEntries: Dictionary = {
    ...(catalog as Dictionary),
    StructTreeRoot: ref(rootNumber),
    MarkInfo: { Marked: true },
    Metadata: ref(metadataNumber),
    ...(tree.language ? { Lang: tree.language } : {}),
  };
  const preferencesNumber = refNumber(catalog, 'ViewerPreferences');
  if (preferencesNumber !== undefined) {
    const preferences = await readObject(bytes, xref, preferencesNumber);
    objects.set(preferencesNumber, { ...(isDictionary(preferences) ? preferences : {}), DisplayDocTitle: true });
  } else {
    const inline = entryOf(catalog, 'ViewerPreferences');
    catalogEntries.ViewerPreferences = { ...(isDictionary(inline) ? inline : {}), DisplayDocTitle: true };
  }
  objects.set(catalogNumber, catalogEntries);

  return appendUpdate(bytes, objects);
}

function xmpPacket(title: string): string {
  const escaped = title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return `<?xpacket begin="\u{feff}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escaped}</rdf:li></rdf:Alt></dc:title>
<pdfuaid:part>1</pdfuaid:part>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const isDictionary = (value: PdfValue | undefined): value is Dictionary =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
  && Object.getOwnPropertySymbols(value).length === 0;
