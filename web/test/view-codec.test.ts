import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PdfViewTransform } from '../dist/types.js';
import { decodeEvent, encodeEvent, WIRE_VERSION } from '../dist/view/codec.js';
import { fittingWidth, fittingSize } from '../dist/view/zoom.js';
import type { PdfViewEvent } from '../dist/view/state.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../../conformance/view-state.json', import.meta.url).pathname, 'utf8'),
);

const viewportEvent = (scale: number, mode: 'free' | 'fitWidth'): PdfViewEvent => ({
  sequence: 1, sessionId: 'a', origin: 'local',
  change: {
    kind: 'viewport',
    state: { pageIndex: 0, center: { x: 1, y: 2 }, zoom: { scale, mode }, rotation: 0, layout: 'single' },
  },
});

describe('the view event wire format', () => {
  test('an unknown version is refused rather than misread', () => {
    assert.throws(() => decodeEvent(JSON.stringify({ v: 999, sequence: 1 })), /version/);
    assert.throws(() => decodeEvent(JSON.stringify({ sequence: 1 })), /version/);
  });

  test('an event survives a round trip', () => {
    const event = viewportEvent(1.5, 'free');
    assert.deepEqual(decodeEvent(encodeEvent(event)), event);
  });

  test('the version rides on the wire but not in the decoded value', () => {
    assert.equal(JSON.parse(encodeEvent(viewportEvent(1, 'free')))['v'], WIRE_VERSION);
    assert.ok(!('v' in (decodeEvent(encodeEvent(viewportEvent(1, 'free'))) as object)));
  });

  test('a scale only Double can hold survives to single precision', () => {
    // Android holds scale as Float. Anything asserted to more than ~1e-6 will disagree
    // there, so the contract is single precision and the fixture avoids finer values.
    const back = decodeEvent(encodeEvent(viewportEvent(1 / 3, 'free')));
    const state = back.change.kind === 'viewport' ? back.change.state : null;
    assert.ok(state && Math.abs(state.zoom.scale - 1 / 3) < 1e-6);
  });

  test('the shared fixture decodes and derives the offsets it claims', () => {
    // The gate that matters: expected offsets in the fixture were computed by
    // independent arithmetic, so agreeing with them is evidence, not self-consistency.
    assert.ok(FIXTURE.cases.length >= 4);

    for (const testCase of FIXTURE.cases) {
      const decoded = decodeEvent(JSON.stringify(testCase.wire));
      assert.equal(decoded.change.kind, 'viewport', testCase.name);
      if (decoded.change.kind !== 'viewport') continue;
      const state = decoded.change.state;

      for (const receiver of testCase.receivers) {
        // A fit is re-derived for this receiver's window; a free zoom is adopted.
        const zoom = state.zoom.mode === 'free'
          ? state.zoom
          : state.zoom.mode === 'fitWidth'
            ? fittingWidth(receiver.viewport.width, testCase.page)
            : fittingSize(receiver.viewport, testCase.page);

        assert.ok(Math.abs(zoom.scale - receiver.expectScale) < 1e-4,
                  `${testCase.name}: scale ${zoom.scale} vs ${receiver.expectScale}`);

        const offset = new PdfViewTransform(testCase.page, zoom.scale)
          .scrollOffsetCentering(state.center, receiver.viewport);

        assert.ok(Math.abs(offset.x - receiver.expectScrollOffset.x) < 0.5,
                  `${testCase.name} @${receiver.viewport.width}: x ${offset.x} vs ${receiver.expectScrollOffset.x}`);
        assert.ok(Math.abs(offset.y - receiver.expectScrollOffset.y) < 0.5,
                  `${testCase.name} @${receiver.viewport.width}: y ${offset.y} vs ${receiver.expectScrollOffset.y}`);
      }
    }
  });

  test('the wire carries rotation in degrees', () => {
    // iOS and Android hold rotation as PDFium's quarter-turn index 0-3, the web as
    // degrees. The wire picks degrees, so a platform writing the index would send 1
    // where this expects 90. Nothing caught that until this case existed, because every
    // other case uses rotation 0, which is identical under both conventions.
    const rotated = FIXTURE.cases.find((c: { expectRotationDegrees?: number }) => c.expectRotationDegrees);
    assert.ok(rotated, 'the fixture must exercise a non-zero rotation');

    const decoded = decodeEvent(JSON.stringify(rotated.wire));
    assert.equal(decoded.change.kind, 'viewport');
    if (decoded.change.kind !== 'viewport') return;
    assert.equal(decoded.change.state.rotation, rotated.expectRotationDegrees);
    assert.equal(decoded.change.state.layout, rotated.expectLayout);
  });

  test('the fixture contains a case that clamps to the far end, not just to zero', () => {
    // A clamp test where every expected offset is zero proves very little.
    const nonZero = FIXTURE.cases.some((c: { receivers: { expectScrollOffset: { x: number; y: number } }[] }) =>
      c.receivers.some((r) => r.expectScrollOffset.x > 0 && r.expectScrollOffset.y > 0));
    assert.ok(nonZero);
  });
});
