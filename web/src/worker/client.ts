/**
 * Main-thread client for the PDFium worker.
 *
 * The returned document and page objects have the same shape as the in-process
 * {@link PdfDocument} and {@link PdfPage}, so calling code is identical. What you gain
 * is {@link PdfWorker.terminate}: PDFium can hang on a malformed page in a way no
 * cancellation can interrupt, and terminating the worker is the only way out.
 */
import { PdfError } from '../errors.js';
import type { PdfImageData } from '../page.js';
import type {
  PdfAnnotation, PdfAttachment, PdfColor, PdfFormField, PdfMetadata, PdfOutlineItem,
  PdfPageRotation, PdfPermissions, PdfPoint, PdfRect, PdfRenderOptions, PdfSaveMode,
  PdfSearchOptions, PdfSize, PdfTextMatch,
} from '../types.js';
import type { RenderResult, UnsentRequest, WorkerRequest, WorkerResponse } from './protocol.js';

export interface PdfWorkerOptions {
  /** URL of the bundled worker entry point. */
  workerUrl: string | URL;
  /**
   * URL of the **ESM** Emscripten glue, `pdfium.esm.js`. A module worker cannot load
   * the classic `pdfium.js` build.
   */
  glueUrl: string | URL;
  /** URL of the matching `pdfium.esm.wasm`. */
  wasmUrl: string | URL;
  /**
   * How long the worker may go without answering, while calls are pending, before it is
   * treated as hung: it is terminated and every pending call rejects with
   * `engineUnresponsive`. PDFium can hang inside a single call on a malformed page, and
   * the worker runs one call at a time, so nothing behind a hung call would ever run.
   * Terminating discards every document open in the worker. Defaults to 30 seconds.
   */
  callTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** Owns the Worker and multiplexes calls onto it. */
export class PdfWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private terminated = false;
  private readonly ready: Promise<void>;
  private readonly callTimeoutMs: number;
  private watchdog?: ReturnType<typeof setTimeout>;

  constructor(options: PdfWorkerOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
    this.worker = new Worker(options.workerUrl, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.settle(event.data);
    this.worker.onerror = (event) => this.rejectAll(new Error(`worker error: ${event.message}`));

    this.ready = this.send({
      op: 'init',
      glueUrl: String(options.glueUrl),
      wasmUrl: String(options.wasmUrl),
    }) as Promise<void>;
  }

  private settle(response: WorkerResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    // Any answer is progress, so the deadline restarts for whatever is still pending.
    this.armWatchdog();

    if (response.ok) {
      entry.resolve(response.result);
    } else {
      const { code, message, detail } = response.error;
      entry.reject(code ? new PdfError(code, message, detail) : new Error(message));
    }
  }

  private rejectAll(error: unknown): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.armWatchdog();
  }

  /**
   * Restarts the deadline, or clears it when nothing is pending. Only answers restart
   * it, never new calls: calls queued behind a hung one must not keep it alive.
   */
  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (this.terminated || this.pending.size === 0) return;
    this.watchdog = setTimeout(() => {
      this.terminated = true;
      this.worker.terminate();
      this.rejectAll(PdfError.engineUnresponsive());
    }, this.callTimeoutMs);
  }

  /** @internal */
  send(request: UnsentRequest, transfer?: Transferable[]): Promise<unknown> {
    if (this.terminated) return Promise.reject(PdfError.closed());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.pending.size === 1) this.armWatchdog();
      this.worker.postMessage({ ...request, id } as WorkerRequest, transfer ?? []);
    });
  }

  async open(bytes: Uint8Array, password?: string): Promise<PdfWorkerDocument> {
    await this.ready;
    // Copy before transferring: the caller's array stays usable.
    const buffer = bytes.slice().buffer;
    const result = (await this.send(
      { op: 'open', bytes: buffer, password }, [buffer],
    )) as { docId: number; pageCount: number };
    return new PdfWorkerDocument(this, result.docId, result.pageCount);
  }

  /**
   * Kills the worker. Every in-flight call rejects with a `cancelled` error.
   *
   * This is the only way to recover from a document that hangs PDFium's renderer, and
   * the reason this client exists. The worker cannot be reused afterwards; construct
   * a new {@link PdfWorker}.
   */
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    this.rejectAll(PdfError.cancelled());
  }

  get isTerminated(): boolean {
    return this.terminated;
  }
}

/** Same surface as the in-process `PdfDocument`, executed in the worker. */
export class PdfWorkerDocument {
  constructor(
    private readonly worker: PdfWorker,
    private readonly docId: number,
    private readonly knownPageCount: number,
  ) {}

  private call(method: string, args: unknown[] = [], pageIndex?: number): Promise<unknown> {
    return this.worker.send({ op: 'call', docId: this.docId, method, args, pageIndex });
  }

  pageCount(): Promise<number> {
    return this.call('pageCount') as Promise<number>;
  }

  async page(index: number): Promise<PdfWorkerPage> {
    if (index < 0 || index >= this.knownPageCount) {
      throw PdfError.pageOutOfRange(index, this.knownPageCount);
    }
    return new PdfWorkerPage(this.worker, this.docId, index);
  }

  permissions(): Promise<PdfPermissions> { return this.call('permissions') as Promise<PdfPermissions>; }
  metadata(): Promise<PdfMetadata> { return this.call('metadata') as Promise<PdfMetadata>; }
  metadataValue(key: string): Promise<string | undefined> {
    return this.call('metadataValue', [key]) as Promise<string | undefined>;
  }
  attachments(): Promise<PdfAttachment[]> { return this.call('attachments') as Promise<PdfAttachment[]>; }
  outline(): Promise<PdfOutlineItem[]> { return this.call('outline') as Promise<PdfOutlineItem[]>; }
  pageSize(index: number): Promise<PdfSize> { return this.call('pageSize', [], index) as Promise<PdfSize>; }
  rotation(index: number): Promise<PdfPageRotation> {
    return this.call('rotation', [], index) as Promise<PdfPageRotation>;
  }
  setRotation(index: number, rotation: PdfPageRotation): Promise<void> {
    return this.call('setRotation', [rotation], index) as Promise<void>;
  }

  async toBytes(mode: PdfSaveMode = 'full'): Promise<Uint8Array> {
    return new Uint8Array((await this.call('toBytes', [mode])) as ArrayBuffer);
  }

  close(): Promise<void> {
    return this.worker.send({ op: 'close', docId: this.docId }) as Promise<void>;
  }
}

/** Same surface as the in-process `PdfPage`, executed in the worker. */
export class PdfWorkerPage {
  constructor(
    private readonly worker: PdfWorker,
    private readonly docId: number,
    readonly index: number,
  ) {}

  private call(method: string, args: unknown[] = []): Promise<unknown> {
    return this.worker.send({ op: 'call', docId: this.docId, method, args, pageIndex: this.index });
  }

  size(): Promise<PdfSize> { return this.call('pageSize') as Promise<PdfSize>; }

  async render(options: PdfRenderOptions = {}): Promise<PdfImageData> {
    const result = (await this.call('page.render', [options])) as RenderResult;
    return { width: result.width, height: result.height, data: new Uint8ClampedArray(result.data) };
  }

  annotations(): Promise<PdfAnnotation[]> { return this.call('page.annotations') as Promise<PdfAnnotation[]>; }
  formFields(): Promise<PdfFormField[]> { return this.call('page.formFields') as Promise<PdfFormField[]>; }

  addInk(strokes: readonly (readonly PdfPoint[])[], color?: PdfColor, lineWidth?: number): Promise<number> {
    return this.call('page.addInk', [strokes, color, lineWidth]) as Promise<number>;
  }
  addNote(rect: PdfRect, contents: string, color?: PdfColor): Promise<number> {
    return this.call('page.addNote', [rect, contents, color]) as Promise<number>;
  }
  removeAnnotation(annotationIndex: number): Promise<void> {
    return this.call('page.removeAnnotation', [annotationIndex]) as Promise<void>;
  }
  setText(value: string, fieldAt: number): Promise<void> {
    return this.call('page.setText', [value, fieldAt]) as Promise<void>;
  }
  setChecked(checked: boolean, fieldAt: number): Promise<void> {
    return this.call('page.setChecked', [checked, fieldAt]) as Promise<void>;
  }
  setOption(optionIndex: number, selected: boolean, fieldAt: number): Promise<void> {
    return this.call('page.setOption', [optionIndex, selected, fieldAt]) as Promise<void>;
  }

  get text(): PdfWorkerTextPage {
    return new PdfWorkerTextPage(this.worker, this.docId, this.index);
  }
}

export class PdfWorkerTextPage {
  constructor(
    private readonly worker: PdfWorker,
    private readonly docId: number,
    private readonly pageIndex: number,
  ) {}

  private call(method: string, args: unknown[] = []): Promise<unknown> {
    return this.worker.send({ op: 'call', docId: this.docId, method, args, pageIndex: this.pageIndex });
  }

  string(): Promise<string> { return this.call('page.text.string') as Promise<string>; }
  characterCount(): Promise<number> { return this.call('page.text.characterCount') as Promise<number>; }
  search(query: string, options?: PdfSearchOptions): Promise<PdfTextMatch[]> {
    return this.call('page.text.search', [query, options]) as Promise<PdfTextMatch[]>;
  }
}
