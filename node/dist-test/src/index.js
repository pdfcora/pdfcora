/**
 * PdfiumKit for Node.
 *
 * The engine, the object model and every method are the web package's: this adds only
 * what a server needs and a browser does not — reading and writing files, PNG output,
 * and a licence key from the environment. Anything not re-exported here is available
 * from `@pdfiumkit/web` directly, and behaves identically.
 */
export * from '@pdfiumkit/web';
import { readFile, writeFile } from 'node:fs/promises';
import { PdfDocument, PdfLicense } from '@pdfiumkit/web';
import { encodePng } from './png.js';
/** Opens a PDF from a path. The bytes are read into memory, as the engine needs them there. */
export async function openFile(path, password) {
    return PdfDocument.open(new Uint8Array(await readFile(path)), password);
}
/** Saves the document to a path. `mode` defaults to a full save, as it does everywhere else. */
export async function saveFile(document, path, mode = 'full') {
    const bytes = await document.toBytes(mode);
    await writeFile(path, bytes);
    return bytes.length;
}
/**
 * Renders a page and encodes it as PNG. The web package returns raw RGBA, which a
 * browser hands to a canvas; on a server a PNG is almost always what is wanted next.
 */
export async function renderPng(page, options = {}) {
    return encodePng(await page.render(options));
}
/** The raw RGBA of a rendered page, for callers that encode it themselves. */
export async function renderRaw(page, options = {}) {
    return page.render(options);
}
/**
 * Applies a licence key from the environment. Without one every feature still works and
 * output carries the trial watermark. Returns whether a key was found, not whether it
 * was valid — `PdfLicense.status` answers that.
 */
export async function useLicenseFromEnvironment(variable = 'PDFIUMKIT_LICENSE_KEY') {
    const key = process.env[variable];
    if (!key)
        return false;
    await PdfLicense.setKey(key);
    return true;
}
export { encodePng };
//# sourceMappingURL=index.js.map