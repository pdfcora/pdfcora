import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, PdfViewer } from '../dist/index.js';

const read = () => new Uint8Array(readFileSync(new URL('../../conformance/corpus/hello_world.pdf', import.meta.url)));
const rect = (left: number, bottom: number, right: number, top: number) => ({ left, bottom, right, top });

async function viewer() {
  return PdfViewer.open(await PdfDocument.open(read()), { width: 400, height: 600 });
}

test('marks are set, replaced and hit-tested topmost first', async () => {
  const v = await viewer();
  v.setMarks([
    { id: 'a', pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: 'pending' },
    { id: 'b', pageIndex: 0, rects: [rect(50, 20, 80, 30)], state: 'pending' },
  ]);
  assert.equal(v.markAt(0, { x: 60, y: 25 }), 'b');
  assert.equal(v.markAt(0, { x: 20, y: 15 }), 'a');
  assert.equal(v.markAt(1, { x: 20, y: 15 }), null);
  v.setMarks([{ id: 'c', pageIndex: 0, rects: [rect(0, 0, 5, 5)], state: 'pending' }]);
  assert.deepEqual(v.marks.map((m) => m.id), ['c']);
});

test('a tap cycles pending, accepted, rejected and back; accept all sets every mark', async () => {
  const v = await viewer();
  v.setMarks([{ id: 'a', pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: 'pending' },
              { id: 'b', pageIndex: 0, rects: [rect(200, 10, 300, 40)], state: 'pending' }]);
  const states: string[] = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(v.tapMark(0, { x: 20, y: 20 }), 'a');
    states.push(v.marks[0]!.state);
  }
  assert.deepEqual(states, ['accepted', 'rejected', 'pending']);
  assert.equal(v.tapMark(0, { x: 150, y: 20 }), null);
  v.setAllMarks('accepted');
  assert.deepEqual(v.marks.map((m) => m.state), ['accepted', 'accepted']);
});

test('marks never reach the event stream a sync transport listens to', async () => {
  const v = await viewer();
  const events: unknown[] = [];
  v.on((event) => events.push(event));
  v.setMarks([{ id: 'a', pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: 'pending' }]);
  v.tapMark(0, { x: 20, y: 20 });
  v.setAllMarks('rejected');
  v.flush();
  assert.deepEqual(events, []);
});
