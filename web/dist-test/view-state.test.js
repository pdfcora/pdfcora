import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { currentPage } from '../dist/view/state.js';
describe('view state', () => {
    test('the current page is the one containing the centre', () => {
        // In continuous layout the viewport straddles pages; defining the current page by
        // the centre keeps it independent of how much of a neighbour is visible.
        const pages = [{ height: 792 }, { height: 792 }, { height: 792 }];
        assert.equal(currentPage(pages, 100, 8), 0);
        assert.equal(currentPage(pages, 900, 8), 1);
        assert.equal(currentPage(pages, 1700, 8), 2);
    });
    test('the gap between pages counts', () => {
        // Ignoring it drifts by whole pages part-way down a long document. Both centres
        // here are inside the content, or the clamp at the end would hide the difference.
        const pages = Array.from({ length: 50 }, () => ({ height: 100 }));
        assert.equal(currentPage(pages, 2250, 10), 20);
        assert.equal(currentPage(pages, 2250, 0), 22, 'two pages out by page 20');
    });
    test('pages of differing heights are walked, not assumed uniform', () => {
        const pages = [{ height: 100 }, { height: 1000 }, { height: 100 }];
        assert.equal(currentPage(pages, 50, 0), 0);
        assert.equal(currentPage(pages, 600, 0), 1);
        assert.equal(currentPage(pages, 1150, 0), 2);
    });
    test('a centre past the end clamps to the last page rather than going out of range', () => {
        assert.equal(currentPage([{ height: 100 }, { height: 100 }], 99999, 0), 1);
        assert.equal(currentPage([], 50, 0), 0);
    });
    test('state survives a JSON round trip', () => {
        const state = {
            pageIndex: 3,
            center: { x: 306, y: 400 },
            zoom: { scale: 1.5, mode: 'free' },
            rotation: 90,
            layout: 'continuous',
        };
        assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
    });
});
//# sourceMappingURL=view-state.test.js.map