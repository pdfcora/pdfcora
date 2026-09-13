/**
 * Just enough DER to walk a PKCS#7 SignedData.
 *
 * This runs on untrusted input — a signature blob out of an arbitrary PDF — so malformed
 * data is the expected case, not the exceptional one. Every read bounds-checks before it
 * indexes, and anything it cannot make sense of throws rather than returning a guess.
 *
 * Deliberately narrow: no encoding, no schema, no types beyond the handful the CMS walk
 * needs. It is not a general ASN.1 library and should not become one.
 */

export interface Tlv {
  /** Identifier octet, e.g. 0x30 SEQUENCE, 0x31 SET, 0xa0 [0] constructed. */
  readonly tag: number;
  /** Offset of the identifier octet, so the whole encoding can be taken verbatim. */
  readonly start: number;
  readonly length: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  /** One past the last byte of the whole tag-length-value triple. */
  readonly end: number;
}

export class DerError extends Error {
  constructor(message: string) {
    super(`DER: ${message}`);
    this.name = 'DerError';
  }
}

/** True when the identifier octet marks a constructed value. */
export const isConstructed = (tag: number): boolean => (tag & 0x20) !== 0;

export function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (offset < 0 || offset >= bytes.length) {
    throw new DerError(`truncated: no tag at offset ${offset}`);
  }

  let cursor = offset;
  const tag = bytes[cursor++]!;

  // High-tag-number form: the low five bits are all set and the number continues in
  // following octets. Nothing in CMS uses it, so it is refused rather than half-read.
  if ((tag & 0x1f) === 0x1f) throw new DerError('high-tag-number form is not supported');

  if (cursor >= bytes.length) throw new DerError('truncated: no length octet');
  const first = bytes[cursor++]!;

  let length: number;
  if (first < 0x80) {
    length = first;
  } else if (first === 0x80) {
    // Permitted in BER, forbidden in DER. Accepting it would mean scanning for an
    // end-of-contents marker, which is exactly the kind of unbounded read to avoid.
    throw new DerError('indefinite length is not valid DER');
  } else {
    const count = first & 0x7f;
    if (count > 4) throw new DerError(`length of ${count} octets is implausible`);
    if (cursor + count > bytes.length) throw new DerError('truncated: length octets');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[cursor++]!;
  }

  const contentStart = cursor;
  const contentEnd = contentStart + length;
  if (contentEnd > bytes.length) {
    throw new DerError(`truncated: value of ${length} bytes runs past the buffer`);
  }
  return { tag, start: offset, length, contentStart, contentEnd, end: contentEnd };
}

/** The immediate children of a constructed value; empty for a primitive one. */
export function children(bytes: Uint8Array, tlv: Tlv): Tlv[] {
  if (!isConstructed(tlv.tag)) return [];

  const out: Tlv[] = [];
  let cursor = tlv.contentStart;
  while (cursor < tlv.contentEnd) {
    const child = readTlv(bytes, cursor);
    if (child.end > tlv.contentEnd) throw new DerError('child runs past its parent');
    if (child.end <= cursor) throw new DerError('zero-width child would not terminate');
    out.push(child);
    cursor = child.end;
  }
  return out;
}

/**
 * Decodes an OBJECT IDENTIFIER to dotted form.
 *
 * The first octet packs two arcs as `40 * first + second`, which is why 1.2 and
 * 2.16 encode so differently — the second arc is unbounded once the first is 2.
 */
export function readOid(bytes: Uint8Array, tlv: Tlv): string {
  if (tlv.length === 0) throw new DerError('empty OID');

  const arcs: number[] = [];
  let value = 0;
  let started = false;

  for (let i = tlv.contentStart; i < tlv.contentEnd; i++) {
    const byte = bytes[i]!;
    value = value * 128 + (byte & 0x7f);
    if (byte & 0x80) continue;                      // continuation

    if (!started) {
      const first = Math.min(Math.floor(value / 40), 2);
      arcs.push(first, value - first * 40);
      started = true;
    } else {
      arcs.push(value);
    }
    value = 0;
  }

  if (value !== 0) throw new DerError('OID ends mid-arc');
  return arcs.join('.');
}

/** INTEGER as a bigint, since certificate serial numbers exceed 2^53. */
export function readInteger(bytes: Uint8Array, tlv: Tlv): bigint {
  if (tlv.length === 0) throw new DerError('empty INTEGER');

  let value = 0n;
  const negative = (bytes[tlv.contentStart]! & 0x80) !== 0;
  for (let i = tlv.contentStart; i < tlv.contentEnd; i++) {
    value = (value << 8n) | BigInt(bytes[i]!);
  }
  if (!negative) return value;
  // Two's complement, for completeness; CMS serials are positive in practice.
  return value - (1n << BigInt(8 * tlv.length));
}

/** The raw bytes of a value, without its tag and length. */
export function contentOf(bytes: Uint8Array, tlv: Tlv): Uint8Array {
  return bytes.subarray(tlv.contentStart, tlv.contentEnd);
}

/** The whole triple including tag and length, which is what signatures cover. */
export function encodingOf(bytes: Uint8Array, tlv: Tlv): Uint8Array {
  return bytes.subarray(tlv.start, tlv.end);
}
