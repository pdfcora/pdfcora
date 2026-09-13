/**
 * Reading an X.509 certificate far enough to verify a signature and judge trust.
 *
 * Names are kept as their raw DER so issuer and subject can be compared byte for byte,
 * which is what chain building requires — re-encoding a name to compare it as text is
 * where subtle mismatches come from.
 */

import { readTlv, children, readOid, readInteger, contentOf, encodingOf, DerError, type Tlv } from './der.js';

const TAG = { sequence: 0x30, set: 0x31, oid: 0x06, bitString: 0x03, context0: 0xa0 } as const;

const OID_COMMON_NAME = '2.5.4.3';

export interface PdfCertificate {
  readonly commonName?: string;
  /** Raw DER of the subject Name, for exact comparison. */
  readonly subject: Uint8Array;
  readonly issuer: Uint8Array;
  readonly serialNumber: bigint;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** SubjectPublicKeyInfo, which is exactly what WebCrypto's `spki` format takes. */
  readonly publicKeyInfo: Uint8Array;
  readonly der: Uint8Array;
}

export function parseCertificate(der: Uint8Array): PdfCertificate {
  const certificate = readTlv(der, 0);
  if (certificate.tag !== TAG.sequence) throw new DerError('certificate is not a SEQUENCE');

  const tbs = children(der, certificate)[0];
  if (!tbs || tbs.tag !== TAG.sequence) throw new DerError('certificate has no tbsCertificate');

  const fields = children(der, tbs);
  // version is [0] EXPLICIT and optional; everything after it shifts by one.
  const base = fields[0]?.tag === TAG.context0 ? 1 : 0;

  const serial = fields[base];
  const issuer = fields[base + 2];
  const validity = fields[base + 3];
  const subject = fields[base + 4];
  const spki = fields[base + 5];
  if (!serial || !issuer || !validity || !subject || !spki) {
    throw new DerError('tbsCertificate is missing required fields');
  }

  const [notBefore, notAfter] = children(der, validity);
  if (!notBefore || !notAfter) throw new DerError('certificate has no validity period');

  return {
    commonName: findCommonName(der, subject),
    subject: encodingOf(der, subject),
    issuer: encodingOf(der, issuer),
    serialNumber: readInteger(der, serial),
    notBefore: parseTime(der, notBefore),
    notAfter: parseTime(der, notAfter),
    publicKeyInfo: encodingOf(der, spki),
    der,
  };
}

/** Name ::= SEQUENCE OF RelativeDistinguishedName (SET OF AttributeTypeAndValue). */
function findCommonName(der: Uint8Array, name: Tlv): string | undefined {
  for (const rdn of children(der, name)) {
    if (rdn.tag !== TAG.set) continue;
    for (const attribute of children(der, rdn)) {
      const [type, value] = children(der, attribute);
      if (!type || !value || type.tag !== TAG.oid) continue;
      if (readOid(der, type) === OID_COMMON_NAME) {
        return new TextDecoder().decode(contentOf(der, value));
      }
    }
  }
  return undefined;
}

/**
 * UTCTime is `YYMMDDHHMMSSZ` with the two-digit year windowed at 2049 per RFC 5280;
 * GeneralizedTime is `YYYYMMDDHHMMSSZ`. Only the Z forms appear in certificates.
 */
function parseTime(der: Uint8Array, tlv: Tlv): Date {
  const text = new TextDecoder().decode(contentOf(der, tlv));
  const utcTime = tlv.tag === 0x17;

  const match = utcTime
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?$/.exec(text);
  if (!match) throw new DerError(`unparseable certificate time ${JSON.stringify(text)}`);

  const [, y, month, day, hour, minute, second] = match;
  const year = utcTime
    ? (Number(y) >= 50 ? 1900 + Number(y) : 2000 + Number(y))
    : Number(y);

  return new Date(Date.UTC(
    year, Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second ?? '0')));
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** A certificate that issued itself, which a chain cannot climb past. */
export const isSelfIssued = (certificate: PdfCertificate): boolean =>
  sameBytes(certificate.subject, certificate.issuer);

/**
 * Orders certificates from the signer upward, following issuer links.
 *
 * Stops at a self-issued certificate or when no issuer is present, so a cycle in a
 * malformed bundle cannot loop forever.
 */
export function buildChain(
  signer: PdfCertificate,
  pool: readonly PdfCertificate[],
): PdfCertificate[] {
  const chain = [signer];
  const seen = new Set([hexOf(signer.der)]);

  let current = signer;
  while (!isSelfIssued(current)) {
    const issuer = pool.find((candidate) => sameBytes(candidate.subject, current.issuer));
    if (!issuer || seen.has(hexOf(issuer.der))) break;
    chain.push(issuer);
    seen.add(hexOf(issuer.der));
    current = issuer;
  }
  return chain;
}

const hexOf = (bytes: Uint8Array) => bytes.length + ':' + bytes.subarray(0, 32).join(',');

/** Also used for the signature over signedAttrs. */
export function bitStringContent(der: Uint8Array, tlv: Tlv): Uint8Array {
  if (tlv.tag !== TAG.bitString) throw new DerError('expected a BIT STRING');
  // The first content octet counts unused trailing bits; certificates always use 0.
  return der.subarray(tlv.contentStart + 1, tlv.contentEnd);
}
