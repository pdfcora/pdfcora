/**
 * License keys: `pk1.<payload>.<signature>`, verified offline against an embedded
 * public key. See docs/superpowers/specs/2026-09-15-licensing-design.md.
 */
export const MODULES = ['editing', 'forms', 'signing', 'redaction', 'ai'];
const trial = (reason, message) => ({ kind: 'trial', reason, message });
function base64url(text) {
    if (!/^[A-Za-z0-9_-]*$/.test(text))
        throw new Error('not base64url');
    const standard = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(standard + '==='.slice((standard.length + 3) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
function parsePayload(bytes) {
    let value;
    try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch {
        return undefined;
    }
    const p = value;
    if (typeof p !== 'object' || p === null || Array.isArray(p))
        return undefined;
    if (typeof p.v !== 'number' || typeof p.id !== 'string' || typeof p.customer !== 'string')
        return undefined;
    if (!strings(p.modules) || typeof p.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.expires))
        return undefined;
    for (const list of ['ios', 'android', 'web']) {
        if (p[list] !== undefined && !strings(p[list]))
            return undefined;
    }
    if (p.server !== undefined && typeof p.server !== 'boolean')
        return undefined;
    return p;
}
export function hostMatches(pattern, host) {
    const p = pattern.toLowerCase();
    const h = host.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : p === h;
}
export async function evaluateKey(key, context) {
    if (key === null || key.trim() === '')
        return trial('noKey', 'no license key set');
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'pk1')
        return trial('malformed', 'license key is malformed');
    let payloadBytes;
    let signature;
    try {
        payloadBytes = base64url(parts[1]);
        signature = base64url(parts[2]);
    }
    catch {
        return trial('malformed', 'license key is malformed');
    }
    const payload = parsePayload(payloadBytes);
    if (!payload)
        return trial('malformed', 'license key is malformed');
    let verified = false;
    try {
        const publicKey = await crypto.subtle.importKey('raw', base64url(context.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        verified = signature.length === 64 && await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, payloadBytes);
    }
    catch {
        verified = false;
    }
    if (!verified)
        return trial('badSignature', 'license key signature is invalid');
    if (payload.v !== 1)
        return trial('unsupportedVersion', `license key version ${payload.v} is not supported by this SDK`);
    if (context.revoked.includes(payload.id))
        return trial('revoked', `license key ${payload.id} has been revoked`);
    if (context.releaseDate > payload.expires) {
        return trial('expired', `license key expired on ${payload.expires}, before this SDK was released on ${context.releaseDate}`);
    }
    if (context.host === null) {
        if (payload.server !== true)
            return trial('wrongApp', 'license key does not allow server use');
    }
    else if (!(payload.web ?? []).some((pattern) => hostMatches(pattern, context.host))) {
        return trial('wrongApp', `key is for ${(payload.web ?? []).join(', ') || 'no web hosts'}, this page is ${context.host}`);
    }
    const modules = MODULES.filter((m) => payload.modules.includes(m));
    return { kind: 'licensed', customer: payload.customer, modules };
}
//# sourceMappingURL=key.js.map