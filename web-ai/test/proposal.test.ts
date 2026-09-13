import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { applyProposals, proposalSet } from '../dist/proposal.js';

describe('proposals', () => {
  test('nothing is written until apply is called', async () => {
    const written: string[] = [];
    const set = proposalSet<string>([
      { id: 'p1', kind: 'formValue', detail: 'Ada', source: 'rules' },
      { id: 'p2', kind: 'formValue', detail: 'Lovelace', source: 'rules' },
    ], async (p) => { written.push(p.id); });

    assert.deepEqual(written, [], 'building the set must not touch the document');

    await applyProposals(set, ['p1']);
    assert.deepEqual(written, ['p1'], 'only the accepted proposal is written');
  });

  test('an id that is not in the set is refused, not silently ignored', async () => {
    const set = proposalSet<string>([], async () => {});
    await assert.rejects(() => applyProposals(set, ['nope']), /unknown proposal/);
  });

  test('a refused id writes nothing at all', async () => {
    // The refusal must come before any write, or a partly-applied set is left behind.
    const written: string[] = [];
    const set = proposalSet<string>(
      [{ id: 'p1', kind: 'altText', detail: 'a cat', source: 'onDevice' }],
      async (p) => { written.push(p.id); },
    );
    await assert.rejects(() => applyProposals(set, ['p1', 'ghost']));
    assert.deepEqual(written, []);
  });

  test('proposals are written in proposal order, not acceptance order', async () => {
    const written: string[] = [];
    const set = proposalSet<string>([
      { id: 'a', kind: 'redaction', detail: 'x', source: 'rules' },
      { id: 'b', kind: 'redaction', detail: 'y', source: 'rules' },
    ], async (p) => { written.push(p.id); });

    await applyProposals(set, ['b', 'a']);
    assert.deepEqual(written, ['a', 'b']);
  });
});
