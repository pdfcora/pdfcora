/**
 * Creating form fields. PDFium can fill fields but cannot create widgets, so new fields are
 * written here as an incremental update: widget dictionaries, the page's /Annots and the
 * Catalog's /AcroForm, merged with whatever is already there.
 */
import { appendUpdate } from './incremental.js';
import { acroFormOf, annotsOf, listPages, readCatalog, readObject, refNumber } from './read.js';
import { nextObjectNumber, scanTrailer } from './scan.js';
import { name, raw, ref } from './values.js';
import { buildXref } from './xref.js';
const DA = '/Helv 0 Tf 0 g';
/** A form XObject body for `raw`: the object wrapper is added when it is serialised. */
function appearance(width, height, body) {
    return raw(new TextEncoder().encode(`<</Type /XObject /Subtype /Form /BBox [0 0 ${width} ${height}] ` +
        `/Length ${body.length}>>\nstream\n${body}\nendstream`));
}
const HELVETICA = { Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica'), Encoding: name('WinAnsiEncoding') };
/** /DR with /Helv, which /DA names, added to an inline font dictionary when missing. */
function resources(existing) {
    if (existing === undefined)
        return { Font: { Helv: HELVETICA } };
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing))
        return existing;
    const dr = existing;
    const font = dr.Font;
    if (font && typeof font === 'object' && !Array.isArray(font) && Object.getOwnPropertySymbols(font).length === 0) {
        const fonts = font;
        return fonts.Helv ? dr : { ...dr, Font: { ...fonts, Helv: HELVETICA } };
    }
    return font === undefined ? { ...dr, Font: { Helv: HELVETICA } } : dr;
}
export async function writeFormFields(bytes, fields) {
    const info = scanTrailer(bytes);
    const xref = await buildXref(bytes);
    const { number: catalogNumber, value: catalog } = await readCatalog(bytes);
    const pages = await listPages(bytes, xref, catalog);
    let next = nextObjectNumber(info);
    const objects = new Map();
    const widgetsByPage = new Map();
    const fieldRefs = [];
    for (const field of fields) {
        const page = pages[field.pageIndex];
        const widget = next++;
        const { left, bottom, right, top } = field.rect;
        const base = {
            Type: name('Annot'), Subtype: name('Widget'), T: field.name,
            ...(field.tooltip ? { TU: field.tooltip } : {}),
            Rect: [left, bottom, right, top], F: 4, P: ref(page), DA,
        };
        if (field.kind === 'text') {
            objects.set(widget, { ...base, FT: name('Tx') });
        }
        else {
            const w = Number((right - left).toFixed(2));
            const h = Number((top - bottom).toFixed(2));
            const on = next++;
            const off = next++;
            // A tick drawn as a path, so the appearance needs no font.
            const tick = `q 0 g 1.5 w ${(w * 0.2).toFixed(2)} ${(h * 0.5).toFixed(2)} m ${(w * 0.42).toFixed(2)} ${(h * 0.22).toFixed(2)} l ` +
                `${(w * 0.8).toFixed(2)} ${(h * 0.8).toFixed(2)} l S Q`;
            objects.set(on, appearance(w, h, tick));
            objects.set(off, appearance(w, h, ''));
            objects.set(widget, {
                ...base, FT: name('Btn'), V: name('Off'), AS: name('Off'),
                AP: { N: { Yes: ref(on), Off: ref(off) } },
            });
        }
        fieldRefs.push(ref(widget));
        widgetsByPage.set(field.pageIndex, [...(widgetsByPage.get(field.pageIndex) ?? []), ref(widget)]);
    }
    for (const [pageIndex, widgets] of widgetsByPage) {
        const number = pages[pageIndex];
        const page = await readObject(bytes, xref, number);
        if (!page || typeof page !== 'object' || Array.isArray(page))
            throw new Error(`fields: page ${pageIndex} is unreadable`);
        const existing = (await annotsOf(bytes, xref, page)) ?? [];
        const annotsNumber = refNumber(page, 'Annots');
        if (annotsNumber !== undefined) {
            objects.set(annotsNumber, [...existing, ...widgets]);
        }
        else {
            objects.set(number, { ...page, Annots: [...existing, ...widgets] });
        }
    }
    const acroForm = (await acroFormOf(bytes, xref, catalog)) ?? {};
    const fieldsNumber = refNumber(acroForm, 'Fields');
    const listed = fieldsNumber !== undefined ? await readObject(bytes, xref, fieldsNumber) : acroForm.Fields;
    const allFields = [...(Array.isArray(listed) ? listed : []), ...fieldRefs];
    if (fieldsNumber !== undefined)
        objects.set(fieldsNumber, allFields);
    const merged = {
        ...acroForm,
        ...(fieldsNumber === undefined ? { Fields: allFields } : {}),
        NeedAppearances: true,
        DA: acroForm.DA ?? DA,
        DR: resources(acroForm.DR),
    };
    const acroFormNumber = refNumber(catalog, 'AcroForm');
    if (acroFormNumber !== undefined) {
        objects.set(acroFormNumber, merged);
    }
    else {
        objects.set(catalogNumber, { ...catalog, AcroForm: merged });
    }
    return appendUpdate(bytes, objects);
}
//# sourceMappingURL=formFields.js.map