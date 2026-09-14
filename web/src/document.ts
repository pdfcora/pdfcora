import { ENGINE_VERSION, engine, readUtf16, withBuffer, withUtf16, type PdfiumModule } from './engine.js';
import { readSignatures } from './signature.js';
import { verifySignature } from './cms/verify.js';
import { signDocument, type PdfSignOptions } from './sign/sign.js';
import { emptyCounts, redactPage, regionsFor, toReport } from './redact/region.js';
import { scrubAnnotations, scrubAttachments } from './redact/scrub.js';
import { PdfError } from './errors.js';
import type {
  PdfAttachment, PdfMetadata, PdfOutlineItem, PdfPermissions, PdfSaveMode, PdfSize,
  PdfPageRotation,
  PdfSignature, PdfSignatureValidity, PdfVerifyOptions,
  PdfRedactionReport, PdfRedactionTarget,
} from './types.js';
import { PdfPage } from './page.js';

/**
 * An open PDF document.
 *
 * Work is serialised per document: every call queues behind the previous one, so the
 * single-threaded WASM engine is never re-entered concurrently. Separate documents
 * have separate queues.
 */
export class PdfDocument {
  /** The PDFium revision this SDK was built against. */
  static readonly engineVersion = ENGINE_VERSION;

  /** @internal */ readonly m: PdfiumModule;
  private handle: number;
  private bufferPtr: number;
  private form = 0;
  private formInfo = 0;
  private closedFlag = false;

  /** Serialises work; also what makes `await`ed calls ordered and non-overlapping. */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * The bytes the document was opened from. A signature's byte range is measured
   * against them, and verification re-hashes them; PDFium's own copy is not
   * byte-identical once edits have been made.
   */
  private readonly originalBytes: Uint8Array;

  private get byteLength(): number { return this.originalBytes.length; }
  private cachedFingerprint?: string;

  /**
   * A stable identifier for the bytes this document was opened from.
   *
   * Two documents opened from identical bytes share it; any difference changes it. Used
   * to refuse replaying an edit against the wrong document — annotation and field
   * indices are positions in specific bytes, so a removal replayed elsewhere removes the
   * wrong thing, silently.
   *
   * FNV-1a rather than a cryptographic digest: this answers "are these the same bytes",
   * not "has someone tampered with them", and it needs no crypto API on any platform.
   * The length is appended, since a hash collision alone should not be enough.
   */
  get fingerprint(): string {
    if (this.cachedFingerprint === undefined) {
      let hash = 0x811c9dc5;
      for (const byte of this.originalBytes) {
        hash ^= byte;
        // The FNV prime, 16777619, by shift-and-add to stay in 32 bits.
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
      }
      this.cachedFingerprint = `${hash.toString(16).padStart(8, '0')}-${this.originalBytes.length}`;
    }
    return this.cachedFingerprint;
  }

  private constructor(m: PdfiumModule, handle: number, bufferPtr: number, bytes: Uint8Array) {
    this.m = m;
    this.handle = handle;
    this.bufferPtr = bufferPtr;
    this.originalBytes = bytes;
  }

  static async open(bytes: Uint8Array, password?: string): Promise<PdfDocument> {
    const m = await engine();
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);

    const handle = m.ccall(
      'FPDF_LoadMemDocument', 'number',
      ['number', 'number', 'string'], [ptr, bytes.length, password ?? null],
    ) as number;

    if (!handle) {
      const lastError = m.ccall('FPDF_GetLastError', 'number', [], []) as number;
      m._free(ptr);
      throw PdfError.fromEngine(lastError, password !== undefined);
    }
    return new PdfDocument(m, handle, ptr, bytes);
  }

  /** @internal Runs `body` with the document handle, serialised and closed-checked. */
  run<T>(body: (handle: number, m: PdfiumModule) => T): Promise<T> {
    const next = this.queue.then(() => {
      if (this.closedFlag || !this.handle) throw PdfError.closed();
      return body(this.handle, this.m);
    });
    // Keep the chain alive even when a caller's promise rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  pageCount(): Promise<number> {
    return this.run((h, m) => m.ccall('FPDF_GetPageCount', 'number', ['number'], [h]) as number);
  }

  async permissions(): Promise<PdfPermissions> {
    const raw = await this.run((h, m) =>
      m.ccall('FPDF_GetDocPermissions', 'number', ['number'], [h]) as number);
    return {
      canPrint: (raw & (1 << 2)) !== 0,
      canModify: (raw & (1 << 3)) !== 0,
      canCopy: (raw & (1 << 4)) !== 0,
      canAnnotate: (raw & (1 << 5)) !== 0,
      canFillForms: (raw & (1 << 8)) !== 0,
    };
  }

  /** A lightweight reference to a page; loading is deferred until the page is used. */
  async page(index: number): Promise<PdfPage> {
    const count = await this.pageCount();
    if (index < 0 || index >= count) throw PdfError.pageOutOfRange(index, count);
    return new PdfPage(this, index);
  }

  async pageSize(index: number): Promise<PdfSize> {
    return this.run((h, m) =>
      withBuffer(m, 8, (ptr) => {
        m.ccall('FPDF_GetPageSizeByIndexF', 'number', ['number', 'number', 'number'], [h, index, ptr]);
        const view = new Float32Array(m.HEAPU8.buffer, ptr, 2);
        return { width: view[0], height: view[1] };
      }));
  }

  async metadata(): Promise<PdfMetadata> {
    const read = (key: string) => this.metadataValue(key);
    const [title, author, subject, keywords, creator, producer] = await Promise.all([
      read('Title'), read('Author'), read('Subject'),
      read('Keywords'), read('Creator'), read('Producer'),
    ]);
    const result: Record<string, string> = {};
    if (title) result.title = title;
    if (author) result.author = author;
    if (subject) result.subject = subject;
    if (keywords) result.keywords = keywords;
    if (creator) result.creator = creator;
    if (producer) result.producer = producer;
    return result as PdfMetadata;
  }

  /** Reads a metadata key that {@link PdfMetadata} does not model. */
  metadataValue(key: string): Promise<string | undefined> {
    return this.run((h, m) => {
      const text = readUtf16(
        m,
        () => m.ccall('FPDF_GetMetaText', 'number', ['number', 'string', 'number', 'number'], [h, key, 0, 0]) as number,
        (ptr, size) => m.ccall('FPDF_GetMetaText', 'number', ['number', 'string', 'number', 'number'], [h, key, ptr, size]),
      );
      return text || undefined;
    });
  }

  attachments(): Promise<PdfAttachment[]> {
    return this.run((h, m) => {
      const count = m.ccall('FPDFDoc_GetAttachmentCount', 'number', ['number'], [h]) as number;
      const result: PdfAttachment[] = [];
      for (let i = 0; i < count; i++) {
        const attachment = m.ccall('FPDFDoc_GetAttachment', 'number', ['number', 'number'], [h, i]) as number;
        if (!attachment) continue;
        result.push({
          name: readUtf16(
            m,
            () => m.ccall('FPDFAttachment_GetName', 'number', ['number', 'number', 'number'], [attachment, 0, 0]) as number,
            (ptr, size) => m.ccall('FPDFAttachment_GetName', 'number', ['number', 'number', 'number'], [attachment, ptr, size]),
          ),
        });
      }
      return result;
    });
  }

  async rotation(pageIndex: number): Promise<PdfPageRotation> {
    const raw = await this.withPage(pageIndex, (page, m) =>
      m.ccall('FPDFPage_GetRotation', 'number', ['number'], [page]) as number);
    return (([0, 90, 180, 270] as const)[raw] ?? 0);
  }

  async setRotation(pageIndex: number, rotation: PdfPageRotation): Promise<void> {
    const raw = { 0: 0, 90: 1, 180: 2, 270: 3 }[rotation];
    await this.withPage(pageIndex, (page, m) => {
      m.ccall('FPDFPage_SetRotation', null, ['number', 'number'], [page, raw]);
    });
  }

  /** @internal The raw document handle, for calls that need it alongside a page. */
  handleForLinks(): number {
    return this.handle;
  }

  /**
   * @internal The form-fill environment, created on first use and released by close().
   *
   * Owned here rather than cached by handle: a closed document's handle is reused by the
   * next one opened, which then inherited a form environment bound to freed memory and
   * silently lost every field edit.
   */
  formHandle(): number {
    if (!this.form) {
      // FPDF_FORMFILLINFO: version first, remaining callbacks left null. PDFium keeps
      // the pointer until the environment exits.
      this.formInfo = this.m._malloc(512);
      this.m.HEAPU8.fill(0, this.formInfo, this.formInfo + 512);
      new Int32Array(this.m.HEAPU8.buffer, this.formInfo, 1)[0] = 2;
      this.form = this.m.ccall('FPDFDOC_InitFormFillEnvironment', 'number',
        ['number', 'number'], [this.handle, this.formInfo]) as number;
    }
    return this.form;
  }

  /** @internal Loads a page, runs `body`, and always closes it. */
  withPage<T>(pageIndex: number, body: (page: number, m: PdfiumModule) => T): Promise<T> {
    return this.run((h, m) => {
      const page = m.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [h, pageIndex]) as number;
      if (!page) throw PdfError.corrupt(`page ${pageIndex} failed to load`);
      try {
        return body(page, m);
      } finally {
        m.ccall('FPDF_ClosePage', null, ['number'], [page]);
      }
    });
  }

  /** The bytes of one embedded attachment. */
  attachmentData(index: number): Promise<Uint8Array> {
    return this.run((h, m) => {
      const count = m.ccall('FPDFDoc_GetAttachmentCount', 'number', ['number'], [h]) as number;
      if (index < 0 || index >= count) throw PdfError.pageOutOfRange(index, count);

      const attachment = m.ccall('FPDFDoc_GetAttachment', 'number', ['number', 'number'], [h, index]) as number;
      if (!attachment) throw PdfError.corrupt(`attachment ${index} unreadable`);

      // Two-call convention: ask for the size, then fill.
      //
      // The out-parameter is `unsigned long`, which is 32-bit under wasm32 — reading it
      // as 64-bit picks up adjacent heap garbage and yields absurd sizes.
      const size = withBuffer(m, 4, (sizePtr) => {
        m.ccall('FPDFAttachment_GetFile', 'number',
          ['number', 'number', 'number', 'number'], [attachment, 0, 0, sizePtr]);
        return new Uint32Array(m.HEAPU8.buffer, sizePtr, 1)[0];
      });
      if (size === 0) return new Uint8Array(0);

      return withBuffer(m, size, (dataPtr) => withBuffer(m, 4, (writtenPtr) => {
        m.ccall('FPDFAttachment_GetFile', 'number',
          ['number', 'number', 'number', 'number'], [attachment, dataPtr, size, writtenPtr]);
        const written = new Uint32Array(m.HEAPU8.buffer, writtenPtr, 1)[0];
        return m.HEAPU8.slice(dataPtr, dataPtr + written);
      }));
    });
  }

  /** Signatures already present in the document. Reading only; nothing is verified. */
  signatures(): Promise<PdfSignature[]> {
    return this.run((h, m) => readSignatures(m, h, this.byteLength));
  }

  /**
   * Verifies a signature this document carries.
   *
   * Reports integrity and trust separately: a signature whose bytes are intact but
   * whose issuer is unknown comes back `untrusted`, never `valid`. Revocation is not
   * checked.
   */
  verify(signature: PdfSignature, options?: PdfVerifyOptions): Promise<PdfSignatureValidity> {
    return verifySignature(this.originalBytes, signature, options);
  }

  /**
   * Signs the document, returning the signed bytes.
   *
   * The original bytes are never modified: the signature is appended as an incremental
   * update, so any signature already present keeps verifying.
   *
   * The caller supplies the CMS implementation. WebCrypto has primitives but not CMS,
   * and bundling a library would burden every consumer including those that only read.
   */
  sign(options: PdfSignOptions): Promise<Uint8Array> {
    return signDocument(this.originalBytes, options);
  }

  /**
   * Removes content, so that it cannot be recovered.
   *
   * The objects a region touches are removed and the page's content stream regenerated.
   * **Save with `'full'` afterwards**: an incremental save leaves the original content
   * stream in the file, and the removed content with it.
   */
  async redact(targets: readonly PdfRedactionTarget[]): Promise<PdfRedactionReport> {
    const counts = emptyCounts();
    const pageCount = await this.pageCount();

    for (const target of targets) {
      if (target.kind === 'region' && (target.pageIndex < 0 || target.pageIndex >= pageCount)) {
        throw PdfError.pageOutOfRange(target.pageIndex, pageCount);
      }
    }

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      // A search target becomes regions: every match's rects on this page. Resolving it
      // here rather than in the caller keeps one redaction path instead of two.
      const regions = [...regionsFor(targets, pageIndex)];
      for (const target of targets) {
        if (target.kind !== 'textMatches') continue;
        const page = await this.page(pageIndex);
        for (const match of await page.text.search(target.query, target.options)) {
          regions.push(...match.rects);
        }
      }
      if (regions.length === 0) continue;

      const changed = await this.withPage(pageIndex, (page, m) => {
        const textPage = m.ccall('FPDFText_LoadPage', 'number', ['number'], [page]) as number;
        try {
          const changedPage = redactPage(m, this.handle, page, textPage, regions, counts);
          // Annotations sit on the page but outside its content stream, so a comment
          // over redacted text survives unless it is removed explicitly.
          scrubAnnotations(m, page, regions, counts);
          return changedPage;
        } finally {
          if (textPage) m.ccall('FPDFText_ClosePage', null, ['number'], [textPage]);
        }
      });
      if (changed) counts.pages.push(pageIndex);
    }

    // Anything carrying a redacted string out of the document, whatever it is attached
    // to. Search targets name the strings; a region target names none.
    const needles = targets
      .filter((t) => t.kind === 'textMatches')
      .map((t) => (t as { query: string }).query)
      .filter((q) => q.length > 0);

    if (needles.length > 0) {
      await this.run((handle, m) => scrubAttachments(m, handle, needles, counts));
    }

    return toReport(counts);
  }

  /** The document outline, or an empty array when there is none. */
  outline(): Promise<PdfOutlineItem[]> {
    return this.run((h, m) => readBookmarks(m, h, 0, 0));
  }

  /** Serialises the document, including any edits made through this SDK. */
  toBytes(mode: PdfSaveMode = 'full'): Promise<Uint8Array> {
    return this.run((h, m) => {
      const chunks: Uint8Array[] = [];
      // FPDF_FILEWRITE is { version, WriteBlock }; the callback receives that pointer.
      const anyModule = m as unknown as {
        addFunction(fn: (...args: number[]) => number, signature: string): number;
        removeFunction(ptr: number): void;
      };
      const callback = anyModule.addFunction((_fw: number, data: number, size: number) => {
        chunks.push(m.HEAPU8.slice(data, data + size));
        return 1;
      }, 'iiii');

      try {
        return withBuffer(m, 8, (writer) => {
          new Int32Array(m.HEAPU8.buffer, writer, 2).set([1, callback]);
          const flag = mode === 'incremental' ? 1 : 2;
          const ok = m.ccall('FPDF_SaveAsCopy', 'number', ['number', 'number', 'number'], [h, writer, flag]) as number;
          if (!ok) throw PdfError.saveFailed('PDFium refused to serialise the document');

          const total = chunks.reduce((sum, c) => sum + c.length, 0);
          if (total === 0) throw PdfError.saveFailed('no bytes were produced');
          const out = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
          }
          return out;
        });
      } finally {
        anyModule.removeFunction(callback);
      }
    });
  }

  /** Releases the document. Further use rejects with a `closed` {@link PdfError}. */
  async close(): Promise<void> {
    if (this.closedFlag) return;
    // Let queued work finish before tearing the handle down.
    await this.queue.catch(() => undefined);
    if (this.closedFlag) return;
    this.closedFlag = true;
    if (this.form) this.m.ccall('FPDFDOC_ExitFormFillEnvironment', null, ['number'], [this.form]);
    if (this.formInfo) this.m._free(this.formInfo);
    this.form = 0;
    this.formInfo = 0;
    this.m.ccall('FPDF_CloseDocument', null, ['number'], [this.handle]);
    this.m._free(this.bufferPtr);
    this.handle = 0;
    this.bufferPtr = 0;
  }

  /** Supports `await using document = await PdfDocument.open(bytes)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

/** Reads a bookmark subtree, guarding against the cycles malformed documents contain. */
function readBookmarks(m: PdfiumModule, doc: number, parent: number, depth: number): PdfOutlineItem[] {
  if (depth >= 32) return [];
  const items: PdfOutlineItem[] = [];
  let current = m.ccall('FPDFBookmark_GetFirstChild', 'number', ['number', 'number'], [doc, parent]) as number;
  let visited = 0;

  while (current && visited < 4096) {
    visited++;
    const title = readUtf16(
      m,
      () => m.ccall('FPDFBookmark_GetTitle', 'number', ['number', 'number', 'number'], [current, 0, 0]) as number,
      (ptr, size) => m.ccall('FPDFBookmark_GetTitle', 'number', ['number', 'number', 'number'], [current, ptr, size]),
    );
    const item: { title: string; pageIndex?: number; children: PdfOutlineItem[] } = {
      title,
      children: readBookmarks(m, doc, current, depth + 1),
    };
    const pageIndex = bookmarkPage(m, doc, current);
    if (pageIndex !== undefined) item.pageIndex = pageIndex;
    items.push(item as PdfOutlineItem);

    current = m.ccall('FPDFBookmark_GetNextSibling', 'number', ['number', 'number'], [doc, current]) as number;
  }
  return items;
}

function bookmarkPage(m: PdfiumModule, doc: number, bookmark: number): number | undefined {
  let dest = m.ccall('FPDFBookmark_GetDest', 'number', ['number', 'number'], [doc, bookmark]) as number;
  if (!dest) {
    const action = m.ccall('FPDFBookmark_GetAction', 'number', ['number'], [bookmark]) as number;
    if (action) dest = m.ccall('FPDFAction_GetDest', 'number', ['number', 'number'], [doc, action]) as number;
  }
  if (!dest) return undefined;
  const index = m.ccall('FPDFDest_GetDestPageIndex', 'number', ['number', 'number'], [doc, dest]) as number;
  return index >= 0 ? index : undefined;
}
