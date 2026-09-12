import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateExpectations } from './validate.mjs';

const corpus = { files: [{ name: 'a.pdf', category: 'basic' }] };

test('a well-formed expectations file has no problems', () => {
  const exp = {
    engine: 'chromium/7243',
    documents: { 'a.pdf': { category: 'basic', opens: true, pageCount: 1,
      pages: [{ width: 200, height: 300 }] } },
  };
  assert.deepEqual(validateExpectations(exp, corpus), []);
});

test('reports a document that is missing from the corpus', () => {
  const exp = { engine: 'x', documents: { 'ghost.pdf': { category: 'basic', opens: true } } };
  const problems = validateExpectations(exp, corpus);
  assert.ok(problems.some(p => p.includes('ghost.pdf')));
});

test('reports a corpus file with no expectations', () => {
  const exp = { engine: 'x', documents: {} };
  const problems = validateExpectations(exp, corpus);
  assert.ok(problems.some(p => p.includes('a.pdf')));
});

test('reports pageCount disagreeing with the pages array', () => {
  const exp = {
    engine: 'x',
    documents: { 'a.pdf': { category: 'basic', opens: true, pageCount: 3,
      pages: [{ width: 1, height: 1 }] } },
  };
  assert.ok(validateExpectations(exp, corpus).some(p => /pageCount/.test(p)));
});

test('requires openError when a document does not open', () => {
  const exp = { engine: 'x', documents: { 'a.pdf': { category: 'basic', opens: false } } };
  assert.ok(validateExpectations(exp, corpus).some(p => /openError/.test(p)));
});
