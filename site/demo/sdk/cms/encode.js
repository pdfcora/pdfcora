/**
 * Writing DER.
 *
 * Only what embedding a timestamp needs: a timestamp request to send, and the four
 * nested wrappers that have to be re-encoded to put the returned token into a
 * SignerInfo's unsigned attributes.
 *
 * Kept separate from the reader, which stays read-only. Nothing here parses.
 */
export const TAG = {
    boolean: 0x01,
    integer: 0x02,
    octetString: 0x04,
    null: 0x05,
    oid: 0x06,
    sequence: 0x30,
    set: 0x31,
    context0: 0xa0,
    context1: 0xa1,
};
/** Encodes one tag-length-value triple, choosing the shortest legal length form. */
export function tlv(tag, content) {
    const length = encodeLength(content.length);
    const out = new Uint8Array(1 + length.length + content.length);
    out[0] = tag;
    out.set(length, 1);
    out.set(content, 1 + length.length);
    return out;
}
function encodeLength(length) {
    if (length < 0x80)
        return Uint8Array.of(length);
    const octets = [];
    for (let value = length; value > 0; value = Math.floor(value / 256)) {
        octets.unshift(value % 256);
    }
    // DER requires the minimum number of octets, which is what building from the value
    // rather than a fixed width gives.
    return Uint8Array.of(0x80 | octets.length, ...octets);
}
export const sequence = (...parts) => tlv(TAG.sequence, concat(parts));
export const set = (...parts) => tlv(TAG.set, concat(parts));
export const octetString = (bytes) => tlv(TAG.octetString, bytes);
export const nullValue = () => tlv(TAG.null, new Uint8Array(0));
export const boolean = (value) => tlv(TAG.boolean, Uint8Array.of(value ? 0xff : 0x00));
/** A non-negative INTEGER, with the leading zero DER requires when the top bit is set. */
export function integer(value) {
    let bytes;
    if (typeof value === 'number') {
        if (value < 0)
            throw new Error('encode: negative integers are not supported');
        bytes = [];
        let remaining = value;
        do {
            bytes.unshift(remaining % 256);
            remaining = Math.floor(remaining / 256);
        } while (remaining > 0);
    }
    else {
        bytes = [...value];
        while (bytes.length > 1 && bytes[0] === 0)
            bytes.shift();
    }
    if ((bytes[0] & 0x80) !== 0)
        bytes.unshift(0);
    return tlv(TAG.integer, Uint8Array.from(bytes));
}
/** Encodes a dotted OID, packing the first two arcs as `40 * first + second`. */
export function oid(dotted) {
    const arcs = dotted.split('.').map(Number);
    if (arcs.length < 2 || arcs.some((a) => !Number.isInteger(a) || a < 0)) {
        throw new Error(`encode: bad OID ${dotted}`);
    }
    const bytes = [arcs[0] * 40 + arcs[1]];
    for (const arc of arcs.slice(2)) {
        const septets = [];
        let remaining = arc;
        do {
            septets.unshift(remaining & 0x7f);
            remaining >>>= 7;
        } while (remaining > 0);
        for (let i = 0; i < septets.length - 1; i++)
            septets[i] |= 0x80;
        bytes.push(...septets);
    }
    return tlv(TAG.oid, Uint8Array.from(bytes));
}
export function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
//# sourceMappingURL=encode.js.map