/**
 * A page's content as a screen reader should hear it: the structure tree mapped to roles, with
 * the text each element marks. Spec: docs/superpowers/specs/2026-09-15-accessible-content-design.md.
 */
const PARAGRAPH = new Set(['P', 'Span', 'Quote', 'Code', 'Link', 'Note', 'Reference', 'BibEntry', 'Caption',
    'TOCI', 'Lbl', 'LBody', 'Index']);
const PASS_THROUGH = new Set(['THead', 'TBody', 'TFoot']);
const collapse = (text) => text.replace(/\s+/g, ' ').trim();
export function accessibleNodes(roots, textById, pageText, pageBounds, fields) {
    const own = (e) => collapse(e.markedContentIds.map((id) => textById.get(id) ?? '').join(' '));
    const all = (e) => collapse([own(e), ...e.children.map(all)].join(' '));
    const bounds = (e) => (e.bounds ? { bounds: e.bounds } : {});
    const map = (e) => {
        const type = e.type;
        const leaf = (role, extra = {}) => {
            const text = e.actualText ? collapse(e.actualText) : all(e);
            return text ? [{ role, ...extra, text, ...bounds(e), children: [] }] : [];
        };
        const container = (role) => {
            const children = e.children.flatMap(map);
            return children.length ? [{ role, text: '', ...bounds(e), children }] : [];
        };
        const heading = /^H([1-6])?$/.exec(type);
        if (heading)
            return leaf('heading', { level: heading[1] ? Number(heading[1]) : 1 });
        if (PARAGRAPH.has(type))
            return leaf('paragraph');
        if (type === 'LI')
            return leaf('listItem');
        if (type === 'TH')
            return leaf('headerCell');
        if (type === 'TD')
            return leaf('cell');
        if (type === 'L' || type === 'TOC')
            return container('list');
        if (type === 'Table')
            return container('table');
        if (type === 'TR')
            return container('row');
        if (PASS_THROUGH.has(type))
            return e.children.flatMap(map);
        if (type === 'Figure' || type === 'Formula') {
            const text = collapse(e.altText ?? e.actualText ?? all(e));
            return [{ role: 'figure', text, ...bounds(e), children: [] }];
        }
        const text = own(e);
        return [...(text ? [{ role: 'paragraph', text, ...bounds(e), children: [] }] : []), ...e.children.flatMap(map)];
    };
    const nodes = roots.length > 0
        ? roots.flatMap(map)
        : collapse(pageText) ? [{ role: 'paragraph', text: collapse(pageText), bounds: pageBounds, children: [] }] : [];
    for (const field of fields) {
        nodes.push({ role: 'formField', text: field.alternateName ?? field.name ?? '', bounds: field.rect, children: [] });
    }
    return nodes;
}
//# sourceMappingURL=accessible.js.map