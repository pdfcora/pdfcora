import { withBuffer, withUtf16 } from '../engine.js';
import { PdfError } from '../errors.js';
import { saveHandle } from '../save.js';
const TEXT = 'PdfiumKit trial';
/** Adds the watermark to `page`, centred on the box and running along its diagonal. */
function placeWatermark(m, document, page, left, bottom, width, height) {
    const text = m.ccall('FPDFPageObj_NewTextObj', 'number', ['number', 'string', 'number'], [document, 'Helvetica-Bold', 100]);
    if (!text)
        return;
    withUtf16(m, TEXT, (ptr) => m.ccall('FPDFText_SetText', 'number', ['number', 'number'], [text, ptr]));
    m.ccall('FPDFPageObj_SetFillColor', 'number', ['number', 'number', 'number', 'number', 'number'], [text, 128, 128, 128, 64]);
    const [l, b, r, t] = withBuffer(m, 16, (ptr) => {
        m.ccall('FPDFPageObj_GetBounds', 'number', ['number', 'number', 'number', 'number', 'number'], [text, ptr, ptr + 4, ptr + 8, ptr + 12]);
        return Array.from(new Float32Array(m.HEAPU8.buffer, ptr, 4));
    });
    const angle = Math.atan2(height, width);
    const scale = (Math.hypot(width, height) * 0.6) / Math.max(1, r - l);
    const [cos, sin] = [Math.cos(angle) * scale, Math.sin(angle) * scale];
    const matrix = ['number', 'number', 'number', 'number', 'number', 'number', 'number'];
    m.ccall('FPDFPageObj_Transform', null, matrix, [text, 1, 0, 0, 1, -(l + r) / 2, -(b + t) / 2]);
    m.ccall('FPDFPageObj_Transform', null, matrix, [text, cos, sin, -sin, cos, left + width / 2, bottom + height / 2]);
    // PDF/UA: the watermark is decoration, so it is an artifact rather than untagged
    // content (7.1-3). Without the mark, remediated trial output fails on every page.
    m.ccall('FPDFPageObj_AddMark', 'number', ['number', 'string'], [text, 'Artifact']);
    m.ccall('FPDFPage_InsertObject', null, ['number', 'number'], [page, text]);
    m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
}
/** Draws the watermark over an already rendered bitmap, leaving the document untouched. */
export function drawWatermark(m, bitmap, width, height) {
    const scratch = m.ccall('FPDF_CreateNewDocument', 'number', [], []);
    if (!scratch)
        return;
    try {
        const page = m.ccall('FPDFPage_New', 'number', ['number', 'number', 'number', 'number'], [scratch, 0, width, height]);
        if (!page)
            return;
        placeWatermark(m, scratch, page, 0, 0, width, height);
        m.ccall('FPDF_RenderPageBitmap', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'], [bitmap, page, 0, 0, width, height, 0, 0]);
        m.ccall('FPDF_ClosePage', null, ['number'], [page]);
    }
    finally {
        m.ccall('FPDF_CloseDocument', null, ['number'], [scratch]);
    }
}
/** Returns a full save of `bytes` with the watermark in every page's content. */
export function stampWatermark(m, bytes) {
    const buffer = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, buffer);
    const document = m.ccall('FPDF_LoadMemDocument', 'number', ['number', 'number', 'string'], [buffer, bytes.length, null]);
    if (!document) {
        m._free(buffer);
        throw PdfError.saveFailed('the saved document could not be reopened to watermark it');
    }
    try {
        const count = m.ccall('FPDF_GetPageCount', 'number', ['number'], [document]);
        for (let index = 0; index < count; index++) {
            const page = m.ccall('FPDF_LoadPage', 'number', ['number', 'number'], [document, index]);
            if (!page)
                continue;
            const box = withBuffer(m, 16, (ptr) => {
                const ok = m.ccall('FPDFPage_GetMediaBox', 'number', ['number', 'number', 'number', 'number', 'number'], [page, ptr, ptr + 4, ptr + 8, ptr + 12]);
                return ok ? Array.from(new Float32Array(m.HEAPU8.buffer, ptr, 4)) : undefined;
            });
            const width = m.ccall('FPDF_GetPageWidthF', 'number', ['number'], [page]);
            const height = m.ccall('FPDF_GetPageHeightF', 'number', ['number'], [page]);
            const [left, bottom] = box ? [box[0], box[1]] : [0, 0];
            placeWatermark(m, document, page, left, bottom, width, height);
            m.ccall('FPDF_ClosePage', null, ['number'], [page]);
        }
        return saveHandle(m, document, 2);
    }
    finally {
        m.ccall('FPDF_CloseDocument', null, ['number'], [document]);
        m._free(buffer);
    }
}
//# sourceMappingURL=watermark.js.map