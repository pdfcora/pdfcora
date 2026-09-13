/**
 * Walking a PKCS#7 SignedData far enough to verify a PDF signature.
 *
 * Only what verification needs: the certificates, the signer's identity, the algorithms,
 * the signed attributes and the signature value. Everything else in the structure is
 * stepped over rather than modelled.
 */

import { readTlv, children, readOid, readInteger, contentOf, encodingOf, DerError, type Tlv } from './der.js';

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  messageDigest: '1.2.840.113549.1.9.4',
} as const;

const TAG = {
  sequence: 0x30,
  set: 0x31,
  octetString: 0x04,
  oid: 0x06,
  integer: 0x02,
  /** [0] constructed — context class, used for both EXPLICIT and IMPLICIT here. */
  context0: 0xa0,
  context1: 0xa1,
} as const;

export interface SignedData {
  /** DER-encoded certificates, in the order the file carries them. */
  readonly certificates: readonly Uint8Array[];
  readonly signerSerial: bigint;
  readonly digestAlgorithm: string;
  readonly signatureAlgorithm: string;
  /**
   * The signed attributes, re-tagged as a SET.
   *
   * This is what the signature is computed over. The file stores them `[0] IMPLICIT`,
   * and verifying against those bytes fails for every signature ever made.
   */
  readonly signedAttrs?: Uint8Array;
  /** The `messageDigest` attribute: the digest the signer committed to. */
  readonly messageDigest?: Uint8Array;
  readonly signature: Uint8Array;
}

export function parseSignedData(pkcs7: Uint8Array): SignedData {
  const contentInfo = expect(pkcs7, readTlv(pkcs7, 0), TAG.sequence, 'ContentInfo');
  const parts = children(pkcs7, contentInfo);

  const contentType = parts[0];
  if (!contentType || contentType.tag !== TAG.oid || readOid(pkcs7, contentType) !== OID.signedData) {
    throw new DerError('not a signedData content type');
  }

  const wrapper = parts[1];
  if (!wrapper || wrapper.tag !== TAG.context0) throw new DerError('signedData has no content');
  const signedData = expect(pkcs7, children(pkcs7, wrapper)[0], TAG.sequence, 'SignedData');

  // version, digestAlgorithms, encapContentInfo, [certificates], [crls], signerInfos
  const fields = children(pkcs7, signedData);
  if (fields.length < 4) throw new DerError('SignedData is too short');

  const digestAlgorithm = algorithmOid(pkcs7, fields[1], 'digestAlgorithms');

  const certificates: Uint8Array[] = [];
  for (const field of fields) {
    if (field.tag !== TAG.context0) continue;
    // [0] IMPLICIT CertificateSet. Its children are the certificates themselves.
    for (const certificate of children(pkcs7, field)) {
      if (certificate.tag === TAG.sequence) {
        certificates.push(encodingOf(pkcs7, certificate));
      }
    }
  }

  const signerInfos = fields.find((f) => f.tag === TAG.set && f !== fields[1]);
  if (!signerInfos) throw new DerError('no signerInfos');
  const signerInfo = expect(pkcs7, children(pkcs7, signerInfos)[0], TAG.sequence, 'SignerInfo');

  return { certificates, ...parseSignerInfo(pkcs7, signerInfo), digestAlgorithm };
}

function parseSignerInfo(pkcs7: Uint8Array, signerInfo: Tlv) {
  // version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature, [1]
  const fields = children(pkcs7, signerInfo);
  if (fields.length < 5) throw new DerError('SignerInfo is too short');

  // sid is IssuerAndSerialNumber: SEQUENCE { issuer Name, serialNumber INTEGER }.
  // The subjectKeyIdentifier form ([0]) is not used by any PDF signer we have seen and
  // would need the certificate to resolve, so it is refused rather than half-handled.
  const sid = fields[1]!;
  if (sid.tag !== TAG.sequence) throw new DerError('subjectKeyIdentifier signer id is not supported');
  const sidParts = children(pkcs7, sid);
  const serial = sidParts.find((p) => p.tag === TAG.integer);
  if (!serial) throw new DerError('signer has no serial number');

  const attrsField = fields.find((f) => f.tag === TAG.context0);
  const signedAttrs = attrsField ? retagAsSet(pkcs7, attrsField) : undefined;
  const messageDigest = attrsField ? findMessageDigest(pkcs7, attrsField) : undefined;

  // The signature is the last OCTET STRING, after the signatureAlgorithm SEQUENCE.
  const algorithmIndex = fields.findIndex((f) => f === attrsField) + 1;
  const signatureAlgorithm = algorithmOid(
    pkcs7, fields[attrsField ? algorithmIndex : fields.length - 2], 'signatureAlgorithm');

  const signature = [...fields].reverse().find((f) => f.tag === TAG.octetString);
  if (!signature) throw new DerError('no signature value');

  return {
    signerSerial: readInteger(pkcs7, serial),
    signatureAlgorithm,
    signedAttrs,
    messageDigest,
    signature: contentOf(pkcs7, signature),
  };
}

/**
 * Re-encodes `[0] IMPLICIT SignedAttributes` as the `SET OF` the signature covers.
 *
 * Only the identifier octet changes; the length and contents are already correct, so
 * the bytes are copied rather than re-encoded.
 */
function retagAsSet(pkcs7: Uint8Array, attrs: Tlv): Uint8Array {
  const out = pkcs7.slice(attrs.start, attrs.end);
  out[0] = TAG.set;
  return out;
}

function findMessageDigest(pkcs7: Uint8Array, attrs: Tlv): Uint8Array | undefined {
  for (const attribute of children(pkcs7, attrs)) {
    if (attribute.tag !== TAG.sequence) continue;
    const [type, values] = children(pkcs7, attribute);
    if (!type || !values || type.tag !== TAG.oid) continue;
    if (readOid(pkcs7, type) !== OID.messageDigest) continue;

    const value = children(pkcs7, values)[0];
    if (value?.tag === TAG.octetString) return contentOf(pkcs7, value);
  }
  return undefined;
}

/** AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL } */
function algorithmOid(pkcs7: Uint8Array, field: Tlv | undefined, what: string): string {
  if (!field) throw new DerError(`missing ${what}`);
  // digestAlgorithms is a SET OF AlgorithmIdentifier; signatureAlgorithm is one directly.
  const identifier = field.tag === TAG.set ? children(pkcs7, field)[0] : field;
  if (!identifier || identifier.tag !== TAG.sequence) throw new DerError(`malformed ${what}`);
  const oid = children(pkcs7, identifier)[0];
  if (!oid || oid.tag !== TAG.oid) throw new DerError(`${what} has no OID`);
  return readOid(pkcs7, oid);
}

function expect(bytes: Uint8Array, tlv: Tlv | undefined, tag: number, what: string): Tlv {
  if (!tlv || tlv.tag !== tag) throw new DerError(`expected ${what}`);
  void bytes;
  return tlv;
}
