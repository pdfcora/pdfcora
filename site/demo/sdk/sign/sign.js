/**
 * Signing a document.
 *
 * The field and its fixed-size placeholder are placed first, then the signed ranges are
 * handed to the caller's CMS implementation and the result is patched into the
 * placeholder without moving a byte.
 *
 * The SDK ships no CMS implementation on web. WebCrypto provides primitives but not
 * CMS, and bundling a library would put a sizeable dependency in front of every consumer
 * — including the ones that only read. The caller supplies a {@link CmsSigner}.
 */
import { addSignatureField } from './field.js';
import { digestOverRanges } from '../cms/verify.js';
import { timestamp } from './timestamp.js';
import { parseSignedData } from '../cms/signedData.js';
const DEFAULT_RESERVED = 8192;
export async function signDocument(base, options) {
    const reservedBytes = options.reservedBytes ?? DEFAULT_RESERVED;
    const placed = await addSignatureField(base, {
        reservedBytes,
        reason: options.reason,
        contactInfo: options.contactInfo,
        fieldName: options.fieldName,
        pageIndex: options.pageIndex,
        subFilter: options.subFilter,
    });
    // The signed content is the file with the placeholder cut out — exactly what the
    // byte range names, and exactly what a verifier will re-assemble.
    const signedContent = concatRanges(placed.bytes, placed.byteRange);
    let cms = await options.signer.sign(signedContent, 'SHA-256');
    if (cms.length === 0)
        throw new Error('sign: the signer returned nothing');
    if (options.timestampUrl) {
        // Any failure here throws, so a document is never returned with a timestamp that
        // was requested and silently not applied.
        const signatureValue = parseSignedData(cms).signature;
        cms = await timestamp(cms, signatureValue, options.timestampUrl, options.fetch);
    }
    if (cms.length > reservedBytes) {
        // Truncating would produce a file that opens and fails to verify, with no clue why.
        throw new Error(`sign: the signature is ${cms.length} bytes but only ${reservedBytes} were reserved; `
            + 'pass a larger reservedBytes');
    }
    return patchContents(placed.bytes, placed.contentsAt, placed.contentsLength, cms);
}
/** Writes the signature into the placeholder as hex, leaving the rest as zeros. */
function patchContents(bytes, contentsAt, contentsLength, cms) {
    const out = new Uint8Array(bytes);
    // contentsAt points at '<'; the hex begins one byte later and the space is already
    // filled with '0', so only the signature's own digits are written.
    let cursor = contentsAt + 1;
    for (const byte of cms) {
        out[cursor++] = HEX[byte >> 4];
        out[cursor++] = HEX[byte & 0x0f];
    }
    if (cursor > contentsAt + contentsLength - 1) {
        throw new Error('sign: the signature overran its placeholder');
    }
    return out;
}
const HEX = new TextEncoder().encode('0123456789ABCDEF');
function concatRanges(bytes, byteRange) {
    let total = 0;
    for (let i = 1; i < byteRange.length; i += 2)
        total += byteRange[i];
    const out = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < byteRange.length; i += 2) {
        out.set(bytes.subarray(byteRange[i], byteRange[i] + byteRange[i + 1]), at);
        at += byteRange[i + 1];
    }
    return out;
}
export { digestOverRanges };
//# sourceMappingURL=sign.js.map