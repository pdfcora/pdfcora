/**
 * Which page the centre falls on, walking the stack of page heights.
 *
 * `gap` is the spacing the app draws between pages. It counts: ignoring it drifts by a
 * whole page part-way down a long document.
 */
export function currentPage(pages, centerY, gap) {
    let bottom = 0;
    for (let index = 0; index < pages.length; index++) {
        bottom += pages[index].height + gap;
        if (centerY < bottom)
            return index;
    }
    // Past the end: the last page, rather than an index nobody can use.
    return Math.max(0, pages.length - 1);
}
//# sourceMappingURL=state.js.map