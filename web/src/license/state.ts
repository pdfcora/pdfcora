import { evaluateKey, type LicenseContext, type PdfLicenseModule, type PdfLicenseStatus } from './key.js';
import { LICENSE_PUBLIC_KEY, RELEASE_DATE, REVOKED } from './build.js';

const hostOfThisContext = (): string | null =>
  typeof location === 'undefined' ? null : location.hostname;

let context: LicenseContext = {
  publicKey: LICENSE_PUBLIC_KEY, revoked: REVOKED, releaseDate: RELEASE_DATE, host: hostOfThisContext(),
};
let key: string | null = null;
let status: PdfLicenseStatus = { kind: 'trial', reason: 'noKey', message: 'no license key set' };
let pending: Promise<PdfLicenseStatus> = Promise.resolve(status);
let warned = false;

function evaluate(): Promise<PdfLicenseStatus> {
  const settled = evaluateKey(key, context).then((result) => {
    if (pending === settled) status = result;
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
  setKey(value: string): Promise<PdfLicenseStatus> {
    key = value;
    return evaluate();
  },
  /** The result of the last settled check. */
  get status(): PdfLicenseStatus {
    return status;
  },
  covers(module: PdfLicenseModule): boolean {
    return status.kind === 'licensed' && status.modules.includes(module);
  },
};

/** @internal Awaited before a document opens, so a key set just before counts. */
export function licenseReady(): Promise<PdfLicenseStatus> {
  return pending;
}

/** @internal */
export function currentKey(): string | null {
  return key;
}

/** @internal Used by the worker host: the check must use the page's hostname. */
export function setKeyForHost(value: string | null, host: string | null): Promise<PdfLicenseStatus> {
  key = value;
  context = { ...context, host };
  return evaluate();
}

/** @internal Logs once per process, the first time anything is watermarked. */
export function noteWatermark(detail: string): void {
  if (warned) return;
  warned = true;
  console.warn(`PDFCora: output is watermarked — ${detail}`);
}

/** @internal Test hook. Not exported from the package entry point. */
export function configureLicenseForTesting(options: {
  publicKey?: string; revoked?: string[]; releaseDate?: string; host?: string | null; key?: string | null;
}): Promise<PdfLicenseStatus> {
  context = {
    publicKey: options.publicKey ?? context.publicKey,
    revoked: options.revoked ?? context.revoked,
    releaseDate: options.releaseDate ?? context.releaseDate,
    host: options.host === undefined ? context.host : options.host,
  };
  if (options.key !== undefined) key = options.key;
  return evaluate();
}
