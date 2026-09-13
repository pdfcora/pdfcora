/**
 * Flate decompression.
 *
 * Needed because a cross-reference stream and the object streams it points into are both
 * compressed, and one corpus document keeps its Catalog inside one. Node supplies the
 * algorithm; this only wraps it so a native error cannot escape into SDK code.
 */

import { inflateSync, inflateRawSync } from 'node:zlib';

export class InflateError extends Error {
  constructor(message: string) {
    super(`inflate: ${message}`);
    this.name = 'InflateError';
  }
}

export function inflate(bytes: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(inflateSync(bytes));
  } catch (first) {
    // Some producers omit the two-byte zlib header. Trying raw deflate before giving up
    // costs nothing and reads files that would otherwise be rejected.
    try {
      return new Uint8Array(inflateRawSync(bytes));
    } catch {
      throw new InflateError(first instanceof Error ? first.message : String(first));
    }
  }
}
