/** Converts a PDF-space rect to top-left-origin view coordinates. */
export function toViewRect(rect, pageHeight, scale = 1) {
    return {
        x: rect.left * scale,
        y: (pageHeight - rect.top) * scale,
        width: (rect.right - rect.left) * scale,
        height: (rect.top - rect.bottom) * scale,
    };
}
/**
 * Converts between PDF page space (bottom-left origin) and view space (top-left).
 *
 * Anything interactive needs both directions: PDF to view to place an overlay, view to
 * PDF to work out what a click landed on. Doing the Y-flip by hand at each call site is
 * where this goes wrong, so it lives here.
 *
 * ```ts
 * const t = PdfViewTransform.fittingWidth(await page.size(), canvas.clientWidth)
 * const box = t.toViewRect(field.rect)          // position a control
 * const hit = t.toPdf({ x: event.offsetX, y: event.offsetY })
 * ```
 */
export class PdfViewTransform {
    pageSize;
    scale;
    constructor(pageSize, 
    /** View pixels per PDF point. */
    scale) {
        this.pageSize = pageSize;
        this.scale = scale;
    }
    /** Derives the scale needed to fit the page into `width` view pixels. */
    static fittingWidth(pageSize, width) {
        // A degenerate page would otherwise give an infinite scale, which silently
        // poisons every later coordinate.
        return new PdfViewTransform(pageSize, pageSize.width > 0 ? width / pageSize.width : 1);
    }
    get viewSize() {
        return { width: this.pageSize.width * this.scale, height: this.pageSize.height * this.scale };
    }
    toView(point) {
        return { x: point.x * this.scale, y: (this.pageSize.height - point.y) * this.scale };
    }
    toViewRect(rect) {
        const topLeft = this.toView({
            x: Math.min(rect.left, rect.right),
            y: Math.max(rect.bottom, rect.top),
        });
        return {
            x: topLeft.x,
            y: topLeft.y,
            width: Math.abs(rect.right - rect.left) * this.scale,
            height: Math.abs(rect.top - rect.bottom) * this.scale,
        };
    }
    toPdf(point) {
        return { x: point.x / this.scale, y: this.pageSize.height - point.y / this.scale };
    }
    toPdfRect(rect) {
        const topLeft = this.toPdf({ x: rect.x, y: rect.y });
        const bottomRight = this.toPdf({ x: rect.x + rect.width, y: rect.y + rect.height });
        return { left: topLeft.x, bottom: bottomRight.y, right: bottomRight.x, top: topLeft.y };
    }
    /**
     * The PDF point currently at the centre of the viewport.
     *
     * This is the transferable form of a scroll position: an offset is in this viewer's
     * own pixels, relative to its own content size, and means nothing on another screen.
     */
    centerForScrollOffset(offset, viewport) {
        return this.toPdf({
            x: offset.x + viewport.width / 2,
            y: offset.y + viewport.height / 2,
        });
    }
    /**
     * Where to scroll so `center` sits in the middle of the viewport.
     *
     * Clamped to the scrollable range, so a centre near a page edge gives a valid offset
     * on a differently shaped screen rather than one outside the content. A viewport
     * larger than the page scrolls to zero and the app centres it.
     */
    scrollOffsetCentering(center, viewport) {
        const view = this.toView(center);
        const content = this.viewSize;
        const clamp = (value, max) => Math.max(0, Math.min(value, Math.max(0, max)));
        return {
            x: clamp(view.x - viewport.width / 2, content.width - viewport.width),
            y: clamp(view.y - viewport.height / 2, content.height - viewport.height),
        };
    }
}
/**
 * Whether `point` falls inside `rect`, edges included.
 *
 * Edge order is normalised first: PDFium returns rects with `left > right` or
 * `bottom > top` often enough that assuming otherwise misses real hits.
 */
export function rectContains(rect, point) {
    return point.x >= Math.min(rect.left, rect.right)
        && point.x <= Math.max(rect.left, rect.right)
        && point.y >= Math.min(rect.bottom, rect.top)
        && point.y <= Math.max(rect.bottom, rect.top);
}
export const BLACK = { red: 0, green: 0, blue: 0, alpha: 255 };
export const YELLOW = { red: 255, green: 255, blue: 0, alpha: 128 };
//# sourceMappingURL=types.js.map