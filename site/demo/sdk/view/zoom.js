export const steps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** A degenerate page would give an infinite or NaN scale, poisoning every coordinate
 *  derived from it, so it falls back to 1:1. */
const safeRatio = (available, page) => (page > 0 ? available / page : 1);
export function fittingWidth(width, page) {
    return { scale: safeRatio(width, page.width), mode: 'fitWidth' };
}
export function fittingSize(size, page) {
    // Whichever dimension runs out first decides; otherwise the page overflows the other.
    return {
        scale: Math.min(safeRatio(size.width, page.width), safeRatio(size.height, page.height)),
        mode: 'fitPage',
    };
}
/** 1:1 based, as Acrobat and Preview mean it. A phone's normal view reads about 64%. */
export function percentage(zoom) {
    return Math.round(zoom.scale * 100);
}
/** Fit based, as most viewers mean it: 100% is whatever fills the window. */
export function percentageOfFit(zoom, fitScale) {
    return fitScale > 0 ? Math.round((zoom.scale / fitScale) * 100) : 100;
}
/**
 * Moves one rung along the ladder.
 *
 * A fit scale is almost never exactly on a rung, so stepping up goes to the first rung
 * above the current scale rather than to a fixed index. The result is always `free`: the
 * user picked this number, so a peer adopts it rather than re-deriving its own fit.
 */
export function stepped(zoom, direction) {
    const scale = direction > 0
        ? steps.find((s) => s > zoom.scale + 1e-9) ?? steps[steps.length - 1]
        : [...steps].reverse().find((s) => s < zoom.scale - 1e-9) ?? steps[0];
    return { scale, mode: 'free' };
}
//# sourceMappingURL=zoom.js.map