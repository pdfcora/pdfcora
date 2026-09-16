/**
 * Writing figure alternate text into the structure tree.
 *
 * PDFium reads structure elements but cannot change them, and its element handles carry
 * no object numbers. So the tree is walked again here, from the bytes, and a figure is
 * found by what both sides agree on: its page and its marked-content ids.
 */
import { appendUpdate } from './incremental.js';
import { listPages, readCatalog, readObject, refNumber } from './read.js';
import { asName, asRef, entryOf } from './values.js';
import { buildXref } from './xref.js';
const MAX_DEPTH = 64;
export class FigureNotFoundError extends Error {
}
/** Every figure element in the document that has marked content on a single page. */
async function figures(bytes, xref) {
    const { value: catalog } = await readCatalog(bytes);
    const pages = new Map((await listPages(bytes, xref, catalog)).map((number, index) => [number, index]));
    const rootNumber = refNumber(catalog, 'StructTreeRoot');
    const root = rootNumber !== undefined
        ? await readObject(bytes, xref, rootNumber)
        : entryOf(catalog, 'StructTreeRoot');
    if (!isDictionary(root))
        return [];
    const found = [];
    const seen = new Set();
    const parents = new Map();
    const resolve = async (value) => {
        const number = asRef(value)?.[0];
        if (number === undefined)
            return [value, undefined];
        if (seen.has(number))
            return [undefined, number];
        seen.add(number);
        return [await readObject(bytes, xref, number), number];
    };
    const kidsOf = (node) => {
        const k = node.K;
        return k === undefined ? [] : Array.isArray(k) ? k : [k];
    };
    const visit = async (node, number, page, depth) => {
        if (depth > MAX_DEPTH)
            return;
        const ownPage = refNumber(node, 'Pg') ?? page;
        const ids = [];
        for (const kid of kidsOf(node)) {
            if (typeof kid === 'number') {
                ids.push([ownPage, kid]);
                continue;
            }
            const [child, childNumber] = await resolve(kid);
            if (!isDictionary(child))
                continue;
            const type = asName(child.Type ?? null);
            if (type === 'MCR' || (child.S === undefined && typeof child.MCID === 'number')) {
                if (typeof child.MCID === 'number')
                    ids.push([refNumber(child, 'Pg') ?? ownPage, child.MCID]);
            }
            else if (type !== 'OBJR' && child.S !== undefined) {
                await visit(child, childNumber, ownPage, depth + 1);
                if (childNumber !== undefined)
                    parents.set(childNumber, number);
            }
        }
        if (asName(node.S ?? null) !== 'Figure' || number === undefined || ids.length === 0)
            return;
        const pageNumbers = new Set(ids.map(([p]) => p));
        const only = [...pageNumbers][0];
        if (pageNumbers.size !== 1 || only === undefined || !pages.has(only))
            return;
        found.push({ number, parent: undefined, pageIndex: pages.get(only), ids: ids.map(([, id]) => id) });
    };
    if (rootNumber !== undefined)
        seen.add(rootNumber);
    for (const kid of kidsOf(root)) {
        const [child, childNumber] = await resolve(kid);
        if (!isDictionary(child) || child.S === undefined)
            continue;
        await visit(child, childNumber, undefined, 1);
        if (childNumber !== undefined)
            parents.set(childNumber, rootNumber);
    }
    return found.map((figure) => ({ ...figure, parent: parents.get(figure.number) }));
}
const sorted = (ids) => [...ids].sort((x, y) => x - y).join(',');
const sameIds = (a, b) => sorted(a) === sorted(b);
/** The figure each edit names. Throws before anything is written when one is missing or ambiguous. */
export async function findFigures(bytes, edits) {
    const all = await figures(bytes, await buildXref(bytes));
    return edits.map((edit) => {
        const matches = all.filter((f) => f.pageIndex === edit.pageIndex && sameIds(f.ids, edit.markedContentIds));
        const label = `page ${edit.pageIndex}, marked content ${edit.markedContentIds.join(',')}`;
        if (matches.length === 0)
            throw new FigureNotFoundError(`no figure on ${label}`);
        if (matches.length > 1)
            throw new FigureNotFoundError(`${matches.length} figures on ${label}`);
        if (edit.decorative && matches[0].parent === undefined) {
            throw new FigureNotFoundError(`the figure on ${label} has no indirect parent to remove it from`);
        }
        return matches[0];
    });
}
/** Appends /Alt for described figures and removes decorative ones from their parents. */
export async function writeFigures(bytes, edits) {
    const targets = await findFigures(bytes, edits);
    const xref = await buildXref(bytes);
    const objects = new Map();
    const current = async (number) => {
        const value = objects.get(number) ?? await readObject(bytes, xref, number);
        if (!isDictionary(value))
            throw new FigureNotFoundError(`object ${number} is unreadable`);
        return value;
    };
    for (const [i, edit] of edits.entries()) {
        const target = targets[i];
        if (edit.decorative) {
            const parent = await current(target.parent);
            const kids = parent.K === undefined ? [] : Array.isArray(parent.K) ? parent.K : [parent.K];
            objects.set(target.parent, { ...parent, K: kids.filter((kid) => asRef(kid)?.[0] !== target.number) });
        }
        else {
            objects.set(target.number, { ...(await current(target.number)), Alt: edit.altText ?? '' });
        }
    }
    return appendUpdate(bytes, objects);
}
const isDictionary = (value) => value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    && Object.getOwnPropertySymbols(value).length === 0;
//# sourceMappingURL=structure.js.map