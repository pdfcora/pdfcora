import type { PdfErrorCode } from '../errors.js';

/**
 * Wire protocol between the main thread and the PDFium worker.
 *
 * Deliberately narrow: one request/response pair keyed by a numeric id, with the
 * operation named as a string. Adding an SDK method means adding a case in the host,
 * not a new message type.
 */

export interface InitRequest {
  id: number;
  op: 'init';
  /** Resolved URL of the Emscripten glue (`pdfium.js`). */
  glueUrl: string;
  /** Resolved URL of `pdfium.wasm`. */
  wasmUrl: string;
  /** The main thread's key and hostname; the check runs here, against the page's host. */
  license?: { key: string | null; host: string | null };
}

export interface OpenRequest {
  id: number;
  op: 'open';
  bytes: ArrayBuffer;
  password?: string;
}

/** A call on an open document, or on one of its pages. */
export interface CallRequest {
  id: number;
  op: 'call';
  docId: number;
  /** Dotted path, e.g. `pageCount`, `page.render`, `page.text.search`. */
  method: string;
  /** Present for page-scoped methods. */
  pageIndex?: number;
  args: unknown[];
}

export interface CloseRequest {
  id: number;
  op: 'close';
  docId: number;
}

export type WorkerRequest = InitRequest | OpenRequest | CallRequest | CloseRequest;

/**
 * A request before its id is assigned. A plain `Omit<WorkerRequest, 'id'>` collapses
 * the union into one non-discriminated shape, so this distributes over the members.
 */
export type UnsentRequest = WorkerRequest extends infer T
  ? T extends WorkerRequest ? Omit<T, 'id'> : never
  : never;

export interface OkResponse {
  id: number;
  ok: true;
  result: unknown;
}

export interface ErrorResponse {
  id: number;
  ok: false;
  error: {
    /** Present when the failure was a PdfError; absent for unexpected faults. */
    code?: PdfErrorCode;
    message: string;
    detail?: string;
  };
}

export type WorkerResponse = OkResponse | ErrorResponse;

/** Rendered pixels as they cross the boundary; `data` is transferred, not copied. */
export interface RenderResult {
  width: number;
  height: number;
  data: ArrayBuffer;
}
