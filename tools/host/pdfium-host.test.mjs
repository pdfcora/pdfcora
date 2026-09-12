import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPdfium } from './pdfium-host.mjs';

const CORPUS = '/Users/daos/Projects/Lab/pdfiumkit/src/pdfium/testing/resources';
let pdfium;
before(async () => { pdfium = await loadPdfium(); });

test('opens a document and reports page count', () => {
  const doc = pdfium.openDocument(readFileSync(`${CORPUS}/combobox_form.pdf`));
  assert.equal(doc.pageCount, 1);
  doc.close();
});

test('reports page dimensions in points', () => {
  const doc = pdfium.openDocument(readFileSync(`${CORPUS}/combobox_form.pdf`));
  const { width, height } = doc.pageSize(0);
  assert.equal(Math.round(width), 300);
  assert.equal(Math.round(height), 600);
  doc.close();
});

test('a password-protected document fails without a password', () => {
  assert.throws(
    () => pdfium.openDocument(readFileSync(`${CORPUS}/encrypted_hello_world_r2.pdf`)),
    /password/i
  );
});

test('a corrupt document raises rather than returning a null handle', () => {
  assert.throws(() => pdfium.openDocument(Uint8Array.from([1, 2, 3, 4])), /load failed/i);
});
