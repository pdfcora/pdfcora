import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PdfViewTransform, rectContains } from '../dist/index.js';
/**
 * PDF space is bottom-left origin, view space is top-left. Mirrors the iOS
 * PdfViewTransformTests so both SDKs are held to the same contract.
 */
describe('PdfViewTransform', () => {
    const page = { width: 200, height: 400 };
    test('the top-left of the page is the origin in view space', () => {
        const t = new PdfViewTransform(page, 1);
        const p = t.toView({ x: 0, y: 400 });
        assert.equal(p.x, 0);
        assert.equal(p.y, 0);
    });
    test('the bottom-left of the page is the bottom in view space', () => {
        const t = new PdfViewTransform(page, 1);
        assert.equal(t.toView({ x: 0, y: 0 }).y, 400);
    });
    test('scale applies to both axes', () => {
        const t = new PdfViewTransform(page, 2);
        const p = t.toView({ x: 10, y: 400 });
        assert.equal(p.x, 20);
        assert.equal(p.y, 0);
        assert.deepEqual(t.viewSize, { width: 400, height: 800 });
    });
    test('points round-trip', () => {
        const t = new PdfViewTransform(page, 1.75);
        for (const original of [{ x: 0, y: 0 }, { x: 37.5, y: 291.25 }, { x: 200, y: 400 }]) {
            const round = t.toPdf(t.toView(original));
            assert.ok(Math.abs(round.x - original.x) < 1e-9, `x for ${JSON.stringify(original)}`);
            assert.ok(Math.abs(round.y - original.y) < 1e-9, `y for ${JSON.stringify(original)}`);
        }
    });
    test('rects round-trip and keep their size', () => {
        const t = new PdfViewTransform(page, 2);
        const original = { left: 10, bottom: 20, right: 60, top: 120 };
        const view = t.toViewRect(original);
        assert.equal(view.width, 100);
        assert.equal(view.height, 200);
        assert.equal(view.y, (400 - 120) * 2);
        const round = t.toPdfRect(view);
        for (const key of ['left', 'bottom', 'right', 'top']) {
            assert.ok(Math.abs(round[key] - original[key]) < 1e-9, key);
        }
    });
    test('fitting a width derives the scale', () => {
        const t = PdfViewTransform.fittingWidth(page, 600);
        assert.equal(t.scale, 3);
        assert.equal(t.viewSize.height, 1200);
    });
    test('a zero-sized page does not produce a non-finite scale', () => {
        const t = PdfViewTransform.fittingWidth({ width: 0, height: 0 }, 100);
        assert.ok(Number.isFinite(t.scale));
    });
});
describe('rectContains', () => {
    const rect = { left: 10, bottom: 20, right: 60, top: 120 };
    test('contains a point inside', () => {
        assert.ok(rectContains(rect, { x: 35, y: 70 }));
    });
    test('is inclusive on the edges', () => {
        assert.ok(rectContains(rect, { x: 10, y: 20 }));
        assert.ok(rectContains(rect, { x: 60, y: 120 }));
    });
    test('rejects points outside', () => {
        assert.ok(!rectContains(rect, { x: 9, y: 70 }));
        assert.ok(!rectContains(rect, { x: 35, y: 121 }));
    });
    /** PDFium returns rects with edges in either order. */
    test('handles inverted edges', () => {
        assert.ok(rectContains({ left: 60, bottom: 120, right: 10, top: 20 }, { x: 35, y: 70 }));
    });
});
//# sourceMappingURL=geometry.test.js.map