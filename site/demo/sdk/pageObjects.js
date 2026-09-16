/**
 * The objects a page is drawn from.
 *
 * Redaction works at this level: a region is resolved to the objects it touches, and
 * those are removed or rewritten. Covering them with a black rectangle would leave
 * every one of them in the file.
 */
import { withBuffer } from './engine.js';
/** PDFium's `FPDF_PAGEOBJ_*` values. */
const KIND = {
    1: 'text', 2: 'path', 3: 'image', 4: 'shading', 5: 'form',
};
export function readPageObjects(m, page, textPage) {
    const count = m.ccall('FPDFPage_CountObjects', 'number', ['number'], [page]);
    if (count <= 0)
        return [];
    const objects = [];
    for (let index = 0; index < count; index++) {
        const handle = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, index]);
        if (!handle)
            continue;
        const type = m.ccall('FPDFPageObj_GetType', 'number', ['number'], [handle]);
        const kind = KIND[type] ?? 'unknown';
        objects.push({
            index,
            kind,
            bounds: readBounds(m, handle),
            ...(kind === 'text'
                ? { text: readText(m, handle, textPage), fontSize: readFontSize(m, handle) }
                : {}),
        });
    }
    return objects;
}
/**
 * Bounds in PDF space, normalised.
 *
 * PDFium returns the corners it happens to hold, which are not always the lower-left
 * and upper-right pair. Normalising here means every intersection test downstream can
 * assume the usual ordering.
 */
function readBounds(m, handle) {
    return withBuffer(m, 16, (ptr) => {
        m.ccall('FPDFPageObj_GetBounds', 'number', ['number', 'number', 'number', 'number', 'number'], [handle, ptr, ptr + 4, ptr + 8, ptr + 12]);
        const values = new Float32Array(m.HEAPU8.buffer, ptr, 4);
        const [left, bottom, right, top] = values;
        return {
            left: Math.min(left, right),
            bottom: Math.min(bottom, top),
            right: Math.max(left, right),
            top: Math.max(bottom, top),
        };
    });
}
/** The text a text object carries, which is what a search-driven redaction matches. */
function readText(m, handle, textPage) {
    const size = m.ccall('FPDFTextObj_GetText', 'number', ['number', 'number', 'number', 'number'], [handle, textPage, 0, 0]);
    // PDFium returns the terminator alone (2 bytes) when there is no text.
    if (size <= 2)
        return undefined;
    return withBuffer(m, size, (ptr) => {
        m.ccall('FPDFTextObj_GetText', 'number', ['number', 'number', 'number', 'number'], [handle, textPage, ptr, size]);
        const units = new Uint16Array(m.HEAPU8.buffer, ptr, size / 2 - 1);
        return String.fromCharCode(...units);
    });
}
/** Needed because a split that loses the size visibly reflows the page. */
function readFontSize(m, handle) {
    return withBuffer(m, 4, (ptr) => {
        const ok = m.ccall('FPDFTextObj_GetFontSize', 'number', ['number', 'number'], [handle, ptr]);
        return ok ? new Float32Array(m.HEAPU8.buffer, ptr, 1)[0] : undefined;
    });
}
//# sourceMappingURL=pageObjects.js.map