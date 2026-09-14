import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  fittingWidth, fittingSize, percentage, percentageOfFit, stepped, steps,
} from '../dist/view/zoom.js';

const LETTER = { width: 612, height: 792 };

describe('zoom', () => {
  test('fit-width derives the scale that fills the width', () => {
    const zoom = fittingWidth(390, LETTER);
    assert.equal(zoom.mode, 'fitWidth');
    assert.ok(Math.abs(zoom.scale - 390 / 612) < 1e-9);
  });

  test('fit-page uses whichever dimension runs out first', () => {
    // A tall page in a wide window is limited by height, not width.
    const zoom = fittingSize({ width: 1200, height: 800 }, LETTER);
    assert.equal(zoom.mode, 'fitPage');
    assert.ok(Math.abs(zoom.scale - 800 / 792) < 1e-9);
  });

  test('the two percentage helpers answer different questions', () => {
    const phone = fittingWidth(390, LETTER);
    // 1:1 based — what Acrobat shows. A phone's normal view is not 100%.
    assert.equal(percentage(phone), 64);
    // Fit based — what a viewer shows. Always 100% at fit, on any screen.
    assert.equal(percentageOfFit(phone, phone.scale), 100);
  });

  test('the same fit reads differently on a desktop, which is the whole point', () => {
    const desktop = fittingWidth(1200, LETTER);
    assert.equal(percentage(desktop), 196);
    assert.equal(percentageOfFit(desktop, desktop.scale), 100);
  });

  test('a degenerate page cannot produce an infinite scale', () => {
    // An infinite or NaN scale silently poisons every coordinate derived from it.
    assert.equal(fittingWidth(390, { width: 0, height: 792 }).scale, 1);
    assert.equal(fittingSize({ width: 390, height: 700 }, { width: 0, height: 0 }).scale, 1);
  });

  test('percentageOfFit survives a zero fit scale', () => {
    assert.equal(percentageOfFit({ scale: 2, mode: 'free' }, 0), 100);
  });

  test('stepping moves through the ladder and clamps at both ends', () => {
    assert.equal(stepped({ scale: 1, mode: 'free' }, 1).scale, 1.25);
    assert.equal(stepped({ scale: 1, mode: 'free' }, -1).scale, 0.75);
    assert.equal(stepped({ scale: 4, mode: 'free' }, 1).scale, 4);
    assert.equal(stepped({ scale: 0.25, mode: 'free' }, -1).scale, 0.25);
  });

  test('stepping from between two rungs lands on the next one up, not past it', () => {
    // A fit scale is almost never exactly on the ladder.
    assert.equal(stepped({ scale: 0.64, mode: 'fitWidth' }, 1).scale, 0.75);
    assert.equal(stepped({ scale: 0.64, mode: 'fitWidth' }, -1).scale, 0.5);
  });

  test('stepping away from a fit leaves fit behind', () => {
    // The number is now deliberate, so a peer adopts it rather than re-deriving
    // a fit from its own window.
    assert.equal(stepped(fittingWidth(390, LETTER), 1).mode, 'free');
  });

  test('the ladder is sorted and contains 1:1', () => {
    assert.deepEqual([...steps].sort((a, b) => a - b), [...steps]);
    assert.ok(steps.includes(1));
  });
});
