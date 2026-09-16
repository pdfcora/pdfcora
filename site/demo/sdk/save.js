import { withBuffer } from './engine.js';
import { PdfError } from './errors.js';
/** Serialises a document handle. `flag` is FPDF_INCREMENTAL (1) or FPDF_NO_INCREMENTAL (2). */
export function saveHandle(m, handle, flag) {
    const chunks = [];
    // FPDF_FILEWRITE is { version, WriteBlock }; the callback receives that pointer.
    const anyModule = m;
    const callback = anyModule.addFunction((_fw, data, size) => {
        chunks.push(m.HEAPU8.slice(data, data + size));
        return 1;
    }, 'iiii');
    try {
        return withBuffer(m, 8, (writer) => {
            new Int32Array(m.HEAPU8.buffer, writer, 2).set([1, callback]);
            const ok = m.ccall('FPDF_SaveAsCopy', 'number', ['number', 'number', 'number'], [handle, writer, flag]);
            if (!ok)
                throw PdfError.saveFailed('PDFium refused to serialise the document');
            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            if (total === 0)
                throw PdfError.saveFailed('no bytes were produced');
            const out = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
            return out;
        });
    }
    finally {
        anyModule.removeFunction(callback);
    }
}
//# sourceMappingURL=save.js.map