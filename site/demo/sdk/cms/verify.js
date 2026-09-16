/**
 * Checking that a signature's byte ranges still hash to what the signer committed to.
 *
 * This is the integrity half of verification and is entirely independent of trust: it
 * proves the bytes have not changed, and says nothing about who signed them.
 */
import { parseSignedData } from './signedData.js';
import { parseCertificate, buildChain, sameBytes, isSelfIssued } from './certificate.js';
import { DerError } from './der.js';
/** Digest algorithms by OID, as they appear in a CMS `digestAlgorithm`. */
const DIGEST_BY_OID = {
    '2.16.840.1.101.3.4.2.1': 'SHA-256',
    '2.16.840.1.101.3.4.2.2': 'SHA-384',
    '2.16.840.1.101.3.4.2.3': 'SHA-512',
    // SHA-1 is listed so a document signed with it is reported as such rather than as
    // malformed. Whether to accept it is a policy decision made further up.
    '1.3.14.3.2.26': 'SHA-1',
};
export function digestNameForOid(oid) {
    return DIGEST_BY_OID[oid];
}
/**
 * Hashes the spans a `/ByteRange` names, in the order it names them.
 *
 * The ranges are offset/length pairs, and the gap between them is the `/Contents`
 * placeholder holding the signature itself — genuinely outside the signed data.
 */
export async function digestOverRanges(bytes, byteRange, algorithm) {
    if (!(algorithm in DIGEST_LENGTHS)) {
        throw new Error(`unsupported digest algorithm ${algorithm}`);
    }
    if (byteRange.length < 2 || byteRange.length % 2 !== 0) {
        throw new Error(`byte range must be offset/length pairs, got ${byteRange.length} values`);
    }
    let total = 0;
    for (let i = 0; i < byteRange.length; i += 2) {
        const start = byteRange[i];
        const length = byteRange[i + 1];
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
        signed.set(bytes.subarray(byteRange[i], byteRange[i] + byteRange[i + 1]), at);
        at += byteRange[i + 1];
    }
    return new Uint8Array(await crypto.subtle.digest(algorithm, signed));
}
const DIGEST_LENGTHS = {
    'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64,
};
/**
 * Whether the file still hashes to the `messageDigest` the signature committed to.
 *
 * False means the bytes changed after signing. It does not mean the signer is untrusted,
 * and the two must never be reported as the same thing.
 */
export async function checkDigest(bytes, signature) {
    const cms = parseSignedData(signature.contents);
    if (!cms.messageDigest)
        return false;
    const algorithm = digestNameForOid(cms.digestAlgorithm);
    if (!algorithm)
        throw new Error(`unsupported digest algorithm ${cms.digestAlgorithm}`);
    const actual = await digestOverRanges(bytes, signature.byteRange, algorithm);
    return timingSafeEqual(actual, cms.messageDigest);
}
/**
 * Compares in constant time with respect to content.
 *
 * A digest comparison is not the classic timing-attack target, but an early return here
 * costs nothing to avoid and the habit is worth keeping in code like this.
 */
export function timingSafeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let difference = 0;
    for (let i = 0; i < a.length; i++)
        difference |= a[i] ^ b[i];
    return difference === 0;
}
/** Signature algorithms by OID, mapped to what WebCrypto needs to import and verify. */
const SIGNATURE_BY_OID = {
    '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
    '1.2.840.113549.1.1.5': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
    // rsaEncryption appears as the signatureAlgorithm when the digest is carried
    // separately in digestAlgorithm, which is common in PDF signers.
    '1.2.840.113549.1.1.1': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' },
    '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' },
    '1.2.840.10045.4.3.4': { name: 'ECDSA', hash: 'SHA-512' },
};
/**
 * Verifies a signature and judges its chain.
 *
 * Integrity and trust are answered separately and never merged: a signature whose bytes
 * are intact but whose issuer is unknown is `untrusted`, and one over changed bytes is
 * `digestMismatch` no matter how trusted the signer is.
 *
 * Revocation is **not** checked. A `valid` verdict means the bytes are unchanged and the
 * chain reaches a supplied anchor — not that the certificate is still in good standing.
 */
export async function verifySignature(bytes, signature, options = {}) {
    let cms;
    try {
        cms = parseSignedData(signature.contents);
    }
    catch (error) {
        return { kind: 'malformed', reason: describe(error) };
    }
    if (signature.subFilter && !SUPPORTED_SUBFILTERS.has(signature.subFilter)) {
        return { kind: 'unsupported', subFilter: signature.subFilter };
    }
    let certificates;
    let signer;
    try {
        certificates = cms.certificates.map((der) => parseCertificate(der));
        signer = certificates.find((c) => c.serialNumber === cms.signerSerial) ?? certificates[0];
    }
    catch (error) {
        return { kind: 'malformed', reason: describe(error) };
    }
    if (!signer)
        return { kind: 'malformed', reason: 'no signer certificate' };
    // Integrity first, so tampering is never reported as a trust problem.
    try {
        if (!await checkDigest(bytes, signature))
            return { kind: 'digestMismatch' };
        if (!await checkSignature(cms, signer))
            return { kind: 'digestMismatch' };
    }
    catch (error) {
        return { kind: 'malformed', reason: describe(error) };
    }
    const now = options.at ?? new Date();
    if (now < signer.notBefore || now > signer.notAfter) {
        return { kind: 'expired', at: signer.notAfter };
    }
    const chain = buildChain(signer, certificates);
    const anchors = (options.trustAnchors ?? []).map((der) => {
        try {
            return parseCertificate(der);
        }
        catch {
            return undefined;
        }
    }).filter((c) => c !== undefined);
    const trusted = chain.some((link) => anchors.some((anchor) => sameBytes(anchor.der, link.der)));
    if (!trusted) {
        const root = chain[chain.length - 1];
        return {
            kind: 'untrusted',
            chain,
            reason: anchors.length === 0
                ? 'no trust anchors were supplied'
                : isSelfIssued(root)
                    ? 'the chain ends at a self-issued certificate that is not an anchor'
                    : 'the issuer is unknown',
        };
    }
    return { kind: 'valid', signer };
}
const SUPPORTED_SUBFILTERS = new Set([
    'adbe.pkcs7.detached', 'ETSI.CAdES.detached', 'adbe.pkcs7.sha1',
]);
/**
 * Verifies the signature over the signed attributes.
 *
 * The signature covers the SET encoding of the attributes, which `parseSignedData`
 * already re-tagged. When there are no signed attributes the signature covers the
 * content directly, which a detached PDF signature never has — so that case is refused
 * rather than guessed at.
 */
async function checkSignature(cms, signer) {
    if (!cms.signedAttrs)
        throw new DerError('signature has no signed attributes');
    const algorithm = SIGNATURE_BY_OID[cms.signatureAlgorithm];
    if (!algorithm)
        throw new DerError(`unsupported signature algorithm ${cms.signatureAlgorithm}`);
    // The digestAlgorithm field is authoritative when present; the signature OID may be
    // the generic rsaEncryption.
    const hash = digestNameForOid(cms.digestAlgorithm) ?? algorithm.hash;
    // Copied rather than passed as a subarray: WebCrypto's BufferSource will not accept
    // a view whose backing buffer is typed as possibly shared.
    const key = await crypto.subtle.importKey('spki', new Uint8Array(signer.publicKeyInfo), algorithm.name === 'ECDSA'
        ? { name: 'ECDSA', namedCurve: curveFor(hash) }
        : { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return crypto.subtle.verify(algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash } : 'RSASSA-PKCS1-v1_5', key, new Uint8Array(cms.signature), new Uint8Array(cms.signedAttrs));
}
const curveFor = (hash) => hash === 'SHA-384' ? 'P-384' : hash === 'SHA-512' ? 'P-521' : 'P-256';
const describe = (error) => error instanceof Error ? error.message : String(error);
//# sourceMappingURL=verify.js.map