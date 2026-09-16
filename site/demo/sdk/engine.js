/**
 * Loads the PDFium WASM module and exposes the low-level helpers the typed API is
 * built on. This is the only file that touches Emscripten directly.
 */
let modulePromise;
let config = {};
export function configureEngine(next) {
    if (modulePromise) {
        throw new Error('configureEngine must be called before the engine is first used');
    }
    config = next;
}
async function defaultFactory() {
    // Node: load the vendored CommonJS glue. Browsers supply a factory via configureEngine.
    const { createRequire } = await import('node:module');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    // dist/engine.js -> package root -> vendor/, which ships inside the package.
    const gluePath = join(here, '..', 'vendor', 'pdfium.js');
    return require(gluePath);
}
/** The initialised PDFium module. Initialises exactly once per process. */
export function engine() {
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
export function withBuffer(m, size, body) {
    const ptr = m._malloc(size);
    try {
        return body(ptr);
    }
    finally {
        m._free(ptr);
    }
}
/**
 * Reads a PDFium UTF-16 string using its two-call "ask for size, then fill" convention.
 * `fill` receives a buffer pointer and its byte length, and returns the bytes written.
 */
export function readUtf16(m, measure, fill) {
    const byteCount = measure();
    // PDFium returns the terminator alone (2 bytes) when the value is absent.
    if (byteCount <= 2)
        return '';
    return withBuffer(m, byteCount, (ptr) => {
        fill(ptr, byteCount);
        const view = new Uint16Array(m.HEAPU8.buffer, ptr, byteCount / 2 - 1);
        return String.fromCharCode(...view);
    });
}
/** Writes a null-terminated UTF-16 string and runs `body` with its pointer. */
export function withUtf16(m, text, body) {
    const units = new Uint16Array(text.length + 1);
    for (let i = 0; i < text.length; i++)
        units[i] = text.charCodeAt(i);
    return withBuffer(m, units.length * 2, (ptr) => {
        new Uint16Array(m.HEAPU8.buffer, ptr, units.length).set(units);
        return body(ptr);
    });
}
//# sourceMappingURL=engine.js.map