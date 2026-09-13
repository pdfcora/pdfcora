import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readTlv, children, readOid, readInteger } from '../dist/cms/der.js';

describe('DER reading', () => {
  test('reads a short-form TLV', () => {
    // SEQUENCE { INTEGER 1 }
    const bytes = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]);
    const tlv = readTlv(bytes, 0);
    assert.equal(tlv.tag, 0x30);
    assert.equal(tlv.length, 3);
    assert.equal(tlv.contentStart, 2);
    assert.equal(tlv.end, 5);
    assert.equal(children(bytes, tlv).length, 1);
  });

  test('reads long-form lengths', () => {
    // A 300-byte OCTET STRING: 04 82 01 2C
    const bytes = new Uint8Array(4 + 300);
    bytes.set([0x04, 0x82, 0x01, 0x2c]);
    const tlv = readTlv(bytes, 0);
    assert.equal(tlv.length, 300);
    assert.equal(tlv.contentStart, 4);
    assert.equal(tlv.end, 304);
  });

  test('reads high-tag-number forms', () => {
    // [0] constructed, context class: a0 02 05 00
    const bytes = new Uint8Array([0xa0, 0x02, 0x05, 0x00]);
    const tlv = readTlv(bytes, 0);
    assert.equal(tlv.tag, 0xa0);
    assert.equal(children(bytes, tlv).length, 1);
  });

  test('decodes an OID', () => {
    // 1.2.840.113549.1.9.4 — the messageDigest attribute
    const bytes = new Uint8Array([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04,
    ]);
    assert.equal(readOid(bytes, readTlv(bytes, 0)), '1.2.840.113549.1.9.4');
  });

  test('decodes the SHA-256 OID, whose first arc is 2', () => {
    // 2.16.840.1.101.3.4.2.1 — the 2.x branch encodes differently from 1.x
    const bytes = new Uint8Array([
      0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
    ]);
    assert.equal(readOid(bytes, readTlv(bytes, 0)), '2.16.840.1.101.3.4.2.1');
  });

  test('reads an INTEGER, including a long serial number', () => {
    assert.equal(readInteger(new Uint8Array([0x02, 0x01, 0x2a]), readTlv(new Uint8Array([0x02, 0x01, 0x2a]), 0)), 42n);
    // A 16-byte serial, as certificates carry.
    const big = new Uint8Array([0x02, 0x04, 0x01, 0x02, 0x03, 0x04]);
    assert.equal(readInteger(big, readTlv(big, 0)), 0x01020304n);
  });

  /** Malformed input is expected, not exceptional: it arrives from untrusted files. */
  test('refuses a length that runs past the buffer', () => {
    assert.throws(() => readTlv(new Uint8Array([0x30, 0x7f]), 0), /truncated|bounds/i);
  });

  test('refuses an indefinite length, which DER forbids', () => {
    assert.throws(() => readTlv(new Uint8Array([0x30, 0x80, 0x00, 0x00]), 0), /indefinite/i);
  });

  test('refuses a length whose own bytes are truncated', () => {
    assert.throws(() => readTlv(new Uint8Array([0x30, 0x82, 0x01]), 0), /truncated|bounds/i);
  });

  test('refuses an empty buffer rather than returning something', () => {
    assert.throws(() => readTlv(new Uint8Array(0), 0), /truncated|bounds/i);
  });

  test('children of a primitive value is empty, not an error', () => {
    const bytes = new Uint8Array([0x02, 0x01, 0x2a]);
    assert.deepEqual(children(bytes, readTlv(bytes, 0)), []);
  });
});
