/**
 * RFC 3161 timestamping, which is what raises a signature from PAdES B-B to B-T.
 *
 * A timestamp is a second signature, made by a timestamp authority over the first one's
 * signature value. It proves the signing happened before a given instant, so the
 * signature stays verifiable after the signer's certificate expires.
 *
 * The token is embedded as an *unsigned* attribute: it is created after the signature
 * exists and therefore cannot be inside what the signature covers.
 */

import { readTlv, children, contentOf, type Tlv } from '../cms/der.js';
import { integer, octetString, oid, sequence, set, tlv, TAG, boolean } from '../cms/encode.js';

const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  /** id-aa-timeStampToken */
  timestampToken: '1.2.840.113549.1.9.16.2.14',
} as const;

export class TimestampError extends Error {
  constructor(message: string) {
    super(`timestamp: ${message}`);
    this.name = 'TimestampError';
  }
}

/**
 * A `TimeStampReq` over `data`'s digest.
 *
 * `certReq` is set so the authority returns its certificate; without it a verifier has
 * nothing to check the token against.
 */
export async function buildTimestampRequest(data: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));

  const nonce = new Uint8Array(8);
  crypto.getRandomValues(nonce);
  // A nonce ties the response to this request, so a replayed one is detectable.
  nonce[0] = nonce[0]! & 0x7f;

  return sequence(
    integer(1),                                          // version
    sequence(sequence(oid(OID.sha256)), octetString(digest)),   // messageImprint
    integer(nonce),
    boolean(true),                                       // certReq
  );
}

/**
 * Extracts the token from a `TimeStampResp`, or explains why there is none.
 *
 * PKIStatus 0 is granted and 1 is granted with modifications; everything else is a
 * refusal and must not produce a half-signed document.
 */
export function parseTimestampResponse(response: Uint8Array): Uint8Array {
  let outer: Tlv;
  try {
    outer = readTlv(response, 0);
  } catch (error) {
    throw new TimestampError(`unreadable response: ${describe(error)}`);
  }
  if (outer.tag !== TAG.sequence) throw new TimestampError('response is not a SEQUENCE');

  const parts = children(response, outer);
  const statusInfo = parts[0];
  if (!statusInfo) throw new TimestampError('response has no status');

  const statusValue = children(response, statusInfo)[0];
  if (!statusValue || statusValue.tag !== TAG.integer) {
    throw new TimestampError('response status is not an INTEGER');
  }
  const status = contentOf(response, statusValue).reduce((n, b) => n * 256 + b, 0);
  if (status !== 0 && status !== 1) {
    throw new TimestampError(`the authority refused the request, PKIStatus ${status}`);
  }

  const token = parts[1];
  if (!token) throw new TimestampError('the response carries no token');
  return response.subarray(token.start, token.end);
}

/**
 * Puts a timestamp token into a CMS SignedData's first SignerInfo.
 *
 * The four wrappers around the SignerInfo are re-encoded rather than patched: their
 * lengths change, and a length that crosses the 127-byte boundary changes width too, so
 * editing bytes in place would corrupt the structure.
 */
export function embedTimestamp(cms: Uint8Array, token: Uint8Array): Uint8Array {
  const contentInfo = readTlv(cms, 0);
  const [contentType, wrapper] = children(cms, contentInfo);
  if (!contentType || !wrapper) throw new TimestampError('not a CMS ContentInfo');

  const signedData = children(cms, wrapper)[0];
  if (!signedData) throw new TimestampError('ContentInfo has no SignedData');

  const fields = children(cms, signedData);
  const signerInfosIndex = fields.findIndex((f, i) => f.tag === TAG.set && i > 1);
  if (signerInfosIndex < 0) throw new TimestampError('SignedData has no signerInfos');

  const signerInfos = children(cms, fields[signerInfosIndex]!);
  const first = signerInfos[0];
  if (!first) throw new TimestampError('signerInfos is empty');

  if (first.tag !== TAG.sequence) throw new TimestampError('malformed SignerInfo');
  if (children(cms, first).some((f) => f.tag === TAG.context1)) {
    throw new TimestampError('the SignerInfo already carries unsigned attributes');
  }

  const attribute = sequence(oid(OID.timestampToken), set(token));
  const unsignedAttrs = tlv(TAG.context1, attribute);

  const newSignerInfo = sequence(contentOf(cms, first), unsignedAttrs);
  const newSignerInfos = set(
    ...signerInfos.slice(1).map((info) => cms.subarray(info.start, info.end)),
    newSignerInfo,
  );
  const newSignedData = sequence(
    ...fields.slice(0, signerInfosIndex).map((f) => cms.subarray(f.start, f.end)),
    newSignerInfos,
    ...fields.slice(signerInfosIndex + 1).map((f) => cms.subarray(f.start, f.end)),
  );

  return sequence(
    cms.subarray(contentType.start, contentType.end),
    tlv(TAG.context0, newSignedData),
  );
}

/** Requests a token from `url` and embeds it. */
export async function timestamp(
  cms: Uint8Array,
  signatureValue: Uint8Array,
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const request = await buildTimestampRequest(signatureValue);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/timestamp-query' },
      body: new Uint8Array(request),
    });
  } catch (error) {
    // A document with no timestamp is better than one with a broken signature, so the
    // caller is told rather than handed a half-signed file.
    throw new TimestampError(`could not reach the authority: ${describe(error)}`);
  }

  if (!response.ok) throw new TimestampError(`the authority returned HTTP ${response.status}`);
  const token = parseTimestampResponse(new Uint8Array(await response.arrayBuffer()));
  return embedTimestamp(cms, token);
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
