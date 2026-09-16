/**
 * Splitting a partially covered text run.
 *
 * A region over half a word must remove exactly those characters and leave the rest
 * legible, correctly positioned and in the same font. Removing the whole object instead
 * would erase text nobody asked to redact; leaving it would erase nothing.
 *
 * Characters are dropped on **intersection**, not containment: a character half inside
 * the region is still legible and still in the text layer.
 */
/**
 * Rewrites the text objects a region partially covers.
 *
 * Returns how many were split. Objects the region covers entirely are left to the
 * whole-object path, which is cheaper and does not need the font.
 */
export function splitPartiallyCovered(m, document, page, textPage, regions) {
    const handled = new Set();
    let split = 0;
    const characters = charactersByObject(m, textPage);
    for (const [handle, indices] of characters) {
        const boxes = indices.map((index) => ({ index, box: charBox(m, textPage, index) }));
        const covered = boxes.filter(({ box }) => regions.some((r) => intersects(box, r)));
        // Untouched, or covered outright: neither is this path's business.
        if (covered.length === 0 || covered.length === boxes.length)
            continue;
        const runs = survivingRuns(m, textPage, boxes, new Set(covered.map((c) => c.index)));
        if (!replaceObject(m, document, page, handle, runs))
            continue;
        handled.add(handle);
        split++;
    }
    return { split, handled };
}
/**
 * Which text-page characters belong to which object.
 *
 * A text object holds glyph codes, not characters; the text page is the only thing that
 * knows what they say and where they sit. `FPDFText_GetTextObject` is the link between
 * the two.
 */
function charactersByObject(m, textPage) {
    const count = m.ccall('FPDFText_CountChars', 'number', ['number'], [textPage]);
    const byObject = new Map();
    for (let index = 0; index < count; index++) {
        const handle = m.ccall('FPDFText_GetTextObject', 'number', ['number', 'number'], [textPage, index]);
        if (!handle)
            continue;
        const existing = byObject.get(handle);
        if (existing)
            existing.push(index);
        else
            byObject.set(handle, [index]);
    }
    return byObject;
}
function charBox(m, textPage, index) {
    const ptr = m._malloc(32);
    try {
        m.ccall('FPDFText_GetCharBox', 'number', ['number', 'number', 'number', 'number', 'number', 'number'], [textPage, index, ptr, ptr + 8, ptr + 16, ptr + 24]);
        // The out-parameters are left, right, bottom, top — not the usual rect order.
        const values = new Float64Array(m.HEAPU8.buffer, ptr, 4);
        return {
            left: Math.min(values[0], values[1]),
            right: Math.max(values[0], values[1]),
            bottom: Math.min(values[2], values[3]),
            top: Math.max(values[2], values[3]),
        };
    }
    finally {
        m._free(ptr);
    }
}
const intersects = (a, b) => a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom;
/** Contiguous stretches of characters the region did not touch. */
function survivingRuns(m, textPage, boxes, removed) {
    const runs = [];
    let current;
    for (const { index, box } of boxes) {
        if (removed.has(index)) {
            if (current) {
                runs.push(current);
                current = undefined;
            }
            continue;
        }
        const character = String.fromCharCode(m.ccall('FPDFText_GetUnicode', 'number', ['number', 'number'], [textPage, index]));
        if (current)
            current.text += character;
        else
            current = { text: character, left: box.left, bottom: box.bottom };
    }
    if (current)
        runs.push(current);
    return runs;
}
/**
 * Replaces one object with the runs that survived.
 *
 * The original is removed and each run drawn as its own object rather than the original
 * being edited in place: `FPDFText_SetText` keeps the object's matrix, so a run that no
 * longer starts where the object did would render in the wrong place.
 */
function replaceObject(m, document, page, handle, runs) {
    const font = m.ccall('FPDFTextObj_GetFont', 'number', ['number'], [handle]);
    const fontSize = readFontSize(m, handle);
    if (!font || fontSize === undefined)
        return false;
    const created = [];
    for (const run of runs) {
        const object = m.ccall('FPDFPageObj_CreateTextObj', 'number', ['number', 'number', 'number'], [document, font, fontSize]);
        if (!object)
            return false;
        if (!setText(m, object, run.text))
            return false;
        setMatrix(m, object, run.left, run.bottom);
        created.push(object);
    }
    // Only now that every run is built is the original removed, so a failure part-way
    // through leaves the page as it was rather than half-redacted.
    const removed = m.ccall('FPDFPage_RemoveObject', 'number', ['number', 'number'], [page, handle]);
    if (!removed) {
        for (const object of created)
            m.ccall('FPDFPageObj_Destroy', null, ['number'], [object]);
        return false;
    }
    m.ccall('FPDFPageObj_Destroy', null, ['number'], [handle]);
    for (const object of created) {
        m.ccall('FPDFPage_InsertObject', null, ['number', 'number'], [page, object]);
    }
    return true;
}
function setText(m, object, text) {
    const ptr = m._malloc((text.length + 1) * 2);
    try {
        const units = new Uint16Array(m.HEAPU8.buffer, ptr, text.length + 1);
        for (let i = 0; i < text.length; i++)
            units[i] = text.charCodeAt(i);
        units[text.length] = 0;
        return !!m.ccall('FPDFText_SetText', 'number', ['number', 'number'], [object, ptr]);
    }
    finally {
        m._free(ptr);
    }
}
/** An identity matrix translated to the run's origin, so the glyphs land where they were. */
function setMatrix(m, object, left, bottom) {
    const ptr = m._malloc(24);
    try {
        new Float32Array(m.HEAPU8.buffer, ptr, 6).set([1, 0, 0, 1, left, bottom]);
        m.ccall('FPDFPageObj_SetMatrix', 'number', ['number', 'number'], [object, ptr]);
    }
    finally {
        m._free(ptr);
    }
}
function readFontSize(m, handle) {
    const ptr = m._malloc(4);
    try {
        const ok = m.ccall('FPDFTextObj_GetFontSize', 'number', ['number', 'number'], [handle, ptr]);
        return ok ? new Float32Array(m.HEAPU8.buffer, ptr, 1)[0] : undefined;
    }
    finally {
        m._free(ptr);
    }
}
//# sourceMappingURL=split.js.map