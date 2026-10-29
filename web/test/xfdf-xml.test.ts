import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfError } from '../dist/index.js';
import { formatNumber, parseXml } from '../dist/xfdf/xml.js';

const invalid = (e: unknown) => e instanceof PdfError && e.code === 'invalidOperation';

test('parses elements, attributes, text and the five entities', () => {
  const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1&amp;2" y=\'&quot;&apos;\'><b>t&lt;&gt;&#233;&#x41;</b><c/></a>');
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attributes, { x: '1&2', y: '"\'' });
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0]!.name, 'b');
  assert.equal(root.children[0]!.text, 't<>éA');
  assert.equal(root.children[1]!.name, 'c');
});

test('rejects a DOCTYPE', () => {
  assert.throws(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'), invalid);
});

test('rejects an unknown entity and unclosed tags', () => {
  assert.throws(() => parseXml('<x>&nbsp;</x>'), invalid);
  assert.throws(() => parseXml('<x><y></x>'), invalid);
  assert.throws(() => parseXml('<x>'), invalid);
  assert.throws(() => parseXml('<x/><y/>'), invalid);
  assert.throws(() => parseXml(''), invalid);
});

test('formatNumber trims to 4 decimals', () => {
  assert.equal(formatNumber(1.23456), '1.2346');
  assert.equal(formatNumber(2.5), '2.5');
  assert.equal(formatNumber(-0), '0');
  assert.equal(formatNumber(-0.00001), '0');
  assert.equal(formatNumber(72), '72');
});
