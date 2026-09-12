/**
 * Loads the PDFium WASM module and exposes the low-level helpers the typed API is
 * built on. This is the only file that touches Emscripten directly.
 */

export interface PdfiumModule {
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): any;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
}

export type ModuleFactory = (options?: Record<string, unknown>) => Promise<PdfiumModule>;

let modulePromise: Promise<PdfiumModule> | undefined;

/** Where to find `pdfium.js` / `pdfium.wasm`. Set before the first call to {@link engine}. */
export interface EngineConfig {
  /** Supplies the Emscripten factory. Defaults to a Node `require` of the vendored glue. */
  factory?: ModuleFactory;
  /** Resolves `pdfium.wasm`. Defaults to the vendored path next to the glue. */
  locateFile?: (path: string) => string;
}

let config: EngineConfig = {};

export function configureEngine(next: EngineConfig): void {
  if (modulePromise) {
    throw new Error('configureEngine must be called before the engine is first used');
  }
  config = next;
}

async function defaultFactory(): Promise<ModuleFactory> {
  // Node: load the vendored CommonJS glue. Browsers supply a factory via configureEngine.
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  // dist/engine.js -> package root -> vendor/, which ships inside the package.
  const gluePath = join(here, '..', 'vendor', 'pdfium.js');
  return require(gluePath) as ModuleFactory;
}

/** The initialised PDFium module. Initialises exactly once per process. */
export function engine(): Promise<PdfiumModule> {
  modulePromise ??= (async () => {
    const factory = config.factory ?? (await defaultFactory());
    const options = config.locateFile ? { locateFile: config.locateFile } : {};
    const module = await factory(options);
    module.ccall('FPDF_InitLibrary', null, [], []);
    return module;
  })();
  return modulePromise;
}

/** The PDFium revision this SDK was built against. */
export const ENGINE_VERSION = 'chromium/7243';

// MARK: - Memory helpers

/** Runs `body` with a scratch buffer, always freeing it. */
export function withBuffer<T>(m: PdfiumModule, size: number, body: (ptr: number) => T): T {
  const ptr = m._malloc(size);
  try {
    return body(ptr);
  } finally {
    m._free(ptr);
  }
}

/**
 * Reads a PDFium UTF-16 string using its two-call "ask for size, then fill" convention.
 * `fill` receives a buffer pointer and its byte length, and returns the bytes written.
 */
export function readUtf16(
  m: PdfiumModule,
  measure: () => number,
  fill: (ptr: number, size: number) => void,
): string {
  const byteCount = measure();
  // PDFium returns the terminator alone (2 bytes) when the value is absent.
  if (byteCount <= 2) return '';
  return withBuffer(m, byteCount, (ptr) => {
    fill(ptr, byteCount);
    const view = new Uint16Array(m.HEAPU8.buffer, ptr, byteCount / 2 - 1);
    return String.fromCharCode(...view);
  });
}

/** Writes a null-terminated UTF-16 string and runs `body` with its pointer. */
export function withUtf16<T>(m: PdfiumModule, text: string, body: (ptr: number) => T): T {
  const units = new Uint16Array(text.length + 1);
  for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
  return withBuffer(m, units.length * 2, (ptr) => {
    new Uint16Array(m.HEAPU8.buffer, ptr, units.length).set(units);
    return body(ptr);
  });
}
