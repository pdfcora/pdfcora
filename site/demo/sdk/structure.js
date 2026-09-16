/**
 * A page's structure tree, as PDFium reads it, and re-marking content as an artifact.
 *
 * PDFium's structure-tree API is read-only; writing goes through writer/structure.ts.
 */
import { readUtf16, withBuffer } from './engine.js';
const MAX_DEPTH = 64;
export function readStructure(m, page) {
    const tree = m.ccall('FPDF_StructTree_GetForPage', 'number', ['number'], [page]);
    if (!tree)
        return [];
    try {
        const bounds = boundsByMarkedContentId(m, page);
        const count = m.ccall('FPDF_StructTree_CountChildren', 'number', ['number'], [tree]);
        const roots = [];
        for (let i = 0; i < count; i++) {
            const element = m.ccall('FPDF_StructTree_GetChildAtIndex', 'number', ['number', 'number'], [tree, i]);
            if (element)
                roots.push(readElement(m, element, bounds, 0));
        }
        return roots;
    }
    finally {
        m.ccall('FPDF_StructTree_Close', null, ['number'], [tree]);
    }
}
function readElement(m, element, bounds, depth) {
    const text = (fn) => readUtf16(m, () => m.ccall(fn, 'number', ['number', 'number', 'number'], [element, 0, 0]), (ptr, size) => { m.ccall(fn, 'number', ['number', 'number', 'number'], [element, ptr, size]); }) || undefined;
    const markedContentIds = [];
    const idCount = m.ccall('FPDF_StructElement_GetMarkedContentIdCount', 'number', ['number'], [element]);
    for (let i = 0; i < idCount; i++) {
        const id = m.ccall('FPDF_StructElement_GetMarkedContentIdAtIndex', 'number', ['number', 'number'], [element, i]);
        if (id >= 0)
            markedContentIds.push(id);
    }
    const children = [];
    if (depth < MAX_DEPTH) {
        const childCount = m.ccall('FPDF_StructElement_CountChildren', 'number', ['number'], [element]);
        for (let i = 0; i < childCount; i++) {
            const child = m.ccall('FPDF_StructElement_GetChildAtIndex', 'number', ['number', 'number'], [element, i]);
            if (child)
                children.push(readElement(m, child, bounds, depth + 1));
        }
    }
    const rect = [...markedContentIds.map((id) => bounds.get(id)), ...children.map((c) => c.bounds)]
        .filter((r) => r !== undefined)
        .reduce((all, r) => (all ? union(all, r) : r), undefined);
    return {
        type: text('FPDF_StructElement_GetType') ?? '',
        ...optional('altText', text('FPDF_StructElement_GetAltText')),
        ...optional('actualText', text('FPDF_StructElement_GetActualText')),
        ...optional('title', text('FPDF_StructElement_GetTitle')),
        ...optional('language', text('FPDF_StructElement_GetLang')),
        markedContentIds,
        ...(rect ? { bounds: rect } : {}),
        children,
    };
}
const optional = (key, value) => (value ? { [key]: value } : {});
function boundsByMarkedContentId(m, page) {
    const result = new Map();
    const count = m.ccall('FPDFPage_CountObjects', 'number', ['number'], [page]);
    for (let i = 0; i < count; i++) {
        const object = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, i]);
        const id = object ? m.ccall('FPDFPageObj_GetMarkedContentID', 'number', ['number'], [object]) : -1;
        if (id < 0)
            continue;
        const rect = objectBounds(m, object);
        const known = result.get(id);
        result.set(id, known ? union(known, rect) : rect);
    }
    return result;
}
function objectBounds(m, object) {
    return withBuffer(m, 16, (ptr) => {
        m.ccall('FPDFPageObj_GetBounds', 'number', ['number', 'number', 'number', 'number', 'number'], [object, ptr, ptr + 4, ptr + 8, ptr + 12]);
        const [l, b, r, t] = new Float32Array(m.HEAPU8.buffer, ptr, 4);
        return { left: Math.min(l, r), bottom: Math.min(b, t), right: Math.max(l, r), top: Math.max(b, t) };
    });
}
const union = (a, b) => ({
    left: Math.min(a.left, b.left), bottom: Math.min(a.bottom, b.bottom),
    right: Math.max(a.right, b.right), top: Math.max(a.top, b.top),
});
/**
 * Re-marks every top-level object whose marked content has one of `ids` as an artifact,
 * and regenerates the page's content. Returns how many objects changed.
 */
export function markArtifacts(m, page, ids) {
    let changed = 0;
    const count = m.ccall('FPDFPage_CountObjects', 'number', ['number'], [page]);
    for (let i = 0; i < count; i++) {
        const object = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, i]);
        if (!object)
            continue;
        const marks = m.ccall('FPDFPageObj_CountMarks', 'number', ['number'], [object]);
        for (let k = marks - 1; k >= 0; k--) {
            const mark = m.ccall('FPDFPageObj_GetMark', 'number', ['number', 'number'], [object, k]);
            const id = mark ? withBuffer(m, 4, (out) => {
                const ok = m.ccall('FPDFPageObjMark_GetParamIntValue', 'number', ['number', 'string', 'number'], [mark, 'MCID', out]);
                return ok ? new Int32Array(m.HEAPU8.buffer, out, 1)[0] : -1;
            }) : -1;
            if (!ids.has(id))
                continue;
            m.ccall('FPDFPageObj_RemoveMark', 'number', ['number', 'number'], [object, mark]);
            m.ccall('FPDFPageObj_AddMark', 'number', ['number', 'string'], [object, 'Artifact']);
            changed++;
            break;
        }
    }
    if (changed > 0)
        m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
    return changed;
}
/**
 * Gives each listed object a content mark named `tag`, with an `MCID` parameter unless
 * `mcid` is negative, and regenerates the page's content.
 */
export function markTags(m, document, page, marks) {
    for (const { index, tag, mcid } of marks) {
        const object = m.ccall('FPDFPage_GetObject', 'number', ['number', 'number'], [page, index]);
        if (!object)
            continue;
        const mark = m.ccall('FPDFPageObj_AddMark', 'number', ['number', 'string'], [object, tag]);
        if (mark && mcid >= 0) {
            m.ccall('FPDFPageObjMark_SetIntParam', 'number', ['number', 'number', 'number', 'string', 'number'], [document, object, mark, 'MCID', mcid]);
        }
    }
    m.ccall('FPDFPage_GenerateContent', 'number', ['number'], [page]);
}
/**
 * The page's text split by marked-content id, through each character's text object. A generated
 * character (a space or line break PDFium inserts) belongs to the character before it.
 */
export function textByMarkedContentId(m, page) {
    const byId = new Map();
    let all = '';
    const textPage = m.ccall('FPDFText_LoadPage', 'number', ['number'], [page]);
    if (!textPage)
        return { byId, all };
    try {
        const count = m.ccall('FPDFText_CountChars', 'number', ['number'], [textPage]);
        let current = -1;
        for (let i = 0; i < count; i++) {
            const char = String.fromCodePoint(m.ccall('FPDFText_GetUnicode', 'number', ['number', 'number'], [textPage, i]) || 32);
            all += char;
            const object = m.ccall('FPDFText_GetTextObject', 'number', ['number', 'number'], [textPage, i]);
            if (object)
                current = m.ccall('FPDFPageObj_GetMarkedContentID', 'number', ['number'], [object]);
            if (current >= 0)
                byId.set(current, (byId.get(current) ?? '') + char);
        }
    }
    finally {
        m.ccall('FPDFText_ClosePage', null, ['number'], [textPage]);
    }
    return { byId, all };
}
//# sourceMappingURL=structure.js.map