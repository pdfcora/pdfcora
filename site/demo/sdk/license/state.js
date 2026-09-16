import { evaluateKey } from './key.js';
import { LICENSE_PUBLIC_KEY, RELEASE_DATE, REVOKED } from './build.js';
const hostOfThisContext = () => typeof location === 'undefined' ? null : location.hostname;
let context = {
    publicKey: LICENSE_PUBLIC_KEY, revoked: REVOKED, releaseDate: RELEASE_DATE, host: hostOfThisContext(),
};
let key = null;
let status = { kind: 'trial', reason: 'noKey', message: 'no license key set' };
let pending = Promise.resolve(status);
let warned = false;
function evaluate() {
    const settled = evaluateKey(key, context).then((result) => {
        if (pending === settled)
            status = result;
        return result;
    });
    pending = settled;
    return settled;
}
export const PdfLicense = {
    /**
     * Sets the license key. Call before opening documents or creating a `PdfWorker`.
     * Never rejects: a bad key resolves to a trial status that says why.
     */
    setKey(value) {
        key = value;
        return evaluate();
    },
    /** The result of the last settled check. */
    get status() {
        return status;
    },
    covers(module) {
        return status.kind === 'licensed' && status.modules.includes(module);
    },
};
/** @internal Awaited before a document opens, so a key set just before counts. */
export function licenseReady() {
    return pending;
}
/** @internal */
export function currentKey() {
    return key;
}
/** @internal Used by the worker host: the check must use the page's hostname. */
export function setKeyForHost(value, host) {
    key = value;
    context = { ...context, host };
    return evaluate();
}
/** @internal Logs once per process, the first time anything is watermarked. */
export function noteWatermark(detail) {
    if (warned)
        return;
    warned = true;
    console.warn(`PdfiumKit: output is watermarked — ${detail}`);
}
/** @internal Test hook. Not exported from the package entry point. */
export function configureLicenseForTesting(options) {
    context = {
        publicKey: options.publicKey ?? context.publicKey,
        revoked: options.revoked ?? context.revoked,
        releaseDate: options.releaseDate ?? context.releaseDate,
        host: options.host === undefined ? context.host : options.host,
    };
    if (options.key !== undefined)
        key = options.key;
    return evaluate();
}
//# sourceMappingURL=state.js.map