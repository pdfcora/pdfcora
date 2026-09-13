/**
 * Checking that a signature's byte ranges still hash to what the signer committed to.
 *
 * This is the integrity half of verification and is entirely independent of trust: it
 * proves the bytes have not changed, and says nothing about who signed them.
 */

import type { PdfSignature } from '../types.js';
import { parseSignedData } from './signedData.js';

/** Digest algorithms by OID, as they appear in a CMS `digestAlgorithm`. */
const DIGEST_BY_OID: Record<string, DigestName> = {
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  // SHA-1 is listed so a document signed with it is reported as such rather than as
  // malformed. Whether to accept it is a policy decision made further up.
  '1.3.14.3.2.26': 'SHA-1',
};

export type DigestName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export function digestNameForOid(oid: string): DigestName | undefined {
  return DIGEST_BY_OID[oid];
}

/**
 * Hashes the spans a `/ByteRange` names, in the order it names them.
 *
 * The ranges are offset/length pairs, and the gap between them is the `/Contents`
 * placeholder holding the signature itself — genuinely outside the signed data.
 */
export async function digestOverRanges(
  bytes: Uint8Array,
  byteRange: readonly number[],
  algorithm: DigestName,
): Promise<Uint8Array> {
  if (!(algorithm in DIGEST_LENGTHS)) {
    throw new Error(`unsupported digest algorithm ${algorithm}`);
  }
  if (byteRange.length < 2 || byteRange.length % 2 !== 0) {
    throw new Error(`byte range must be offset/length pairs, got ${byteRange.length} values`);
  }

  let total = 0;
  for (let i = 0; i < byteRange.length; i += 2) {
    const start = byteRange[i]!;
    const length = byteRange[i + 1]!;
    if (start < 0 || length < 0 || start + length > bytes.length) {
      throw new Error(`byte range ${start}+${length} runs past the ${bytes.length}-byte file`);
    }
    total += length;
  }

  // One contiguous buffer: WebCrypto has no streaming digest, and the signed content is
  // the concatenation of the spans in order.
  const signed = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < byteRange.length; i += 2) {
    signed.set(bytes.subarray(byteRange[i]!, byteRange[i]! + byteRange[i + 1]!), at);
    at += byteRange[i + 1]!;
  }

  return new Uint8Array(await crypto.subtle.digest(algorithm, signed));
}

const DIGEST_LENGTHS: Record<DigestName, number> = {
  'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64,
};

/**
 * Whether the file still hashes to the `messageDigest` the signature committed to.
 *
 * False means the bytes changed after signing. It does not mean the signer is untrusted,
 * and the two must never be reported as the same thing.
 */
export async function checkDigest(bytes: Uint8Array, signature: PdfSignature): Promise<boolean> {
  const cms = parseSignedData(signature.contents);
  if (!cms.messageDigest) return false;

  const algorithm = digestNameForOid(cms.digestAlgorithm);
  if (!algorithm) throw new Error(`unsupported digest algorithm ${cms.digestAlgorithm}`);

  const actual = await digestOverRanges(bytes, signature.byteRange, algorithm);
  return timingSafeEqual(actual, cms.messageDigest);
}

/**
 * Compares in constant time with respect to content.
 *
 * A digest comparison is not the classic timing-attack target, but an early return here
 * costs nothing to avoid and the habit is worth keeping in code like this.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}
