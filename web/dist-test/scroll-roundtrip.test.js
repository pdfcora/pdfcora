import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PdfViewTransform } from '../dist/types.js';
const LETTER = { width: 612, height: 792 };
/** Where a scroll offset is allowed to sit, given the content and the window. */
const clamp = (value, max) => Math.max(0, Math.min(value, Math.max(0, max)));
describe('scroll <-> document centre', () => {
    test('offset -> centre -> offset lands where it started', () => {
        // The property that makes cross-platform sync possible. Swept rather than
        // spot-checked: a single example passes with the wrong formula.
        for (const page of [LETTER, { width: 200, height: 1000 }, { width: 1000, height: 200 }]) {
            for (const scale of [0.25, 0.64, 1, 1.96, 4]) {
                for (const viewport of [{ width: 390, height: 700 }, { width: 1200, height: 800 }]) {
                    const t = new PdfViewTransform(page, scale);
                    const content = t.viewSize;
                    const maxX = content.width - viewport.width;
                    const maxY = content.height - viewport.height;
                    for (const offset of [
                        { x: 0, y: 0 },
                        { x: clamp(maxX, maxX), y: clamp(maxY, maxY) },
                        { x: clamp(maxX / 2, maxX), y: clamp(maxY / 2, maxY) },
                    ]) {
                        const centre = t.centerForScrollOffset(offset, viewport);
                        const back = t.scrollOffsetCentering(centre, viewport);
                        const where = `page ${page.width}x${page.height} scale ${scale} viewport ${viewport.width}`;
                        assert.ok(Math.abs(back.x - offset.x) < 0.5, `${where}: x ${back.x} vs ${offset.x}`);
                        assert.ok(Math.abs(back.y - offset.y) < 0.5, `${where}: y ${back.y} vs ${offset.y}`);
                    }
                }
            }
        }
    });
    test('a known offset maps to a hand-computed centre, and back', () => {
        // Round trips alone cannot catch a symmetric error: both directions sharing the
        // same mistake still invert each other. Mutation-testing this suite proved it —
        // dividing the viewport by 3 in *both* functions passed every round-trip case.
        // So one case is worked out by hand and asserted absolutely.
        //
        //   page 612x792 at scale 1, viewport 400x600, offset (100, 50)
        //   view centre = (100 + 200, 50 + 300) = (300, 350)
        //   toPdf       = (300 / 1, 792 - 350 / 1) = (300, 442)
        const t = new PdfViewTransform(LETTER, 1);
        const viewport = { width: 400, height: 600 };
        const centre = t.centerForScrollOffset({ x: 100, y: 50 }, viewport);
        assert.ok(Math.abs(centre.x - 300) < 1e-9, `x ${centre.x}`);
        assert.ok(Math.abs(centre.y - 442) < 1e-9, `y ${centre.y}`);
        const offset = t.scrollOffsetCentering({ x: 300, y: 442 }, viewport);
        assert.ok(Math.abs(offset.x - 100) < 1e-9, `x ${offset.x}`);
        assert.ok(Math.abs(offset.y - 50) < 1e-9, `y ${offset.y}`);
    });
    test('a centre near the edge clamps into the scrollable range', () => {
        // A peer with a differently shaped window must land as close as it can, not at an
        // offset outside its own content.
        const t = new PdfViewTransform(LETTER, 1);
        const offset = t.scrollOffsetCentering({ x: 0, y: 792 }, { width: 1200, height: 800 });
        assert.equal(offset.x, 0);
        assert.equal(offset.y, 0);
    });
    test('a viewport larger than the page scrolls nowhere', () => {
        const t = new PdfViewTransform(LETTER, 0.5);
        const offset = t.scrollOffsetCentering({ x: 306, y: 396 }, { width: 1200, height: 900 });
        assert.equal(offset.x, 0);
        assert.equal(offset.y, 0);
    });
    test('two differently shaped windows agree on what is in the middle', () => {
        // The whole point of syncing a centre rather than an offset. Both viewers must
        // actually be scrollable on the axis under test, or the comparison is vacuous.
        const phone = new PdfViewTransform(LETTER, 1.5);
        const desktop = new PdfViewTransform(LETTER, 3);
        const phoneViewport = { width: 390, height: 700 };
        const desktopViewport = { width: 1200, height: 800 };
        const centre = phone.centerForScrollOffset({ x: 120, y: 300 }, phoneViewport);
        const desktopOffset = desktop.scrollOffsetCentering(centre, desktopViewport);
        const backOnDesktop = desktop.centerForScrollOffset(desktopOffset, desktopViewport);
        assert.ok(Math.abs(backOnDesktop.x - centre.x) < 1, `x ${backOnDesktop.x} vs ${centre.x}`);
        assert.ok(Math.abs(backOnDesktop.y - centre.y) < 1, `y ${backOnDesktop.y} vs ${centre.y}`);
    });
    test('a page that fits entirely is centred, whatever centre it is sent', () => {
        // Not a defect: when the content is narrower than the window there is nowhere to
        // scroll, so the middle of the window is the middle of the page by definition. A
        // peer showing the whole page cannot reproduce an off-centre view, and should not
        // pretend to.
        const t = new PdfViewTransform(LETTER, 1.96); // 1199.5px of content
        const viewport = { width: 1200, height: 2000 }; // ...in a 1200px window
        const offset = t.scrollOffsetCentering({ x: 100, y: 400 }, viewport);
        assert.equal(offset.x, 0);
        const centre = t.centerForScrollOffset(offset, viewport);
        assert.ok(Math.abs(centre.x - LETTER.width / 2) < 1, `the page centre, not the requested one: ${centre.x}`);
    });
});
//# sourceMappingURL=scroll-roundtrip.test.js.map