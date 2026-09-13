/**
 * Whether a feature can run right now.
 *
 * A superset of what any one platform reports: Apple has only available and
 * unavailable, while Android and Web genuinely distinguish a model that could be
 * downloaded from one that is downloading. The mapping is per-platform and lossy in
 * Apple's direction, which is why each platform pins its own mapping in a test.
 */
export type PdfAiAvailability =
  | { readonly kind: 'available' }
  | { readonly kind: 'downloadable' }
  | { readonly kind: 'downloading'; readonly progress?: number }
  | { readonly kind: 'unavailable'; readonly reason: PdfAiUnavailableReason };

export type PdfAiUnavailableReason =
  /** The hardware cannot run it. */
  | 'deviceNotEligible'
  /** The user turned the platform's AI off. */
  | 'notEnabled'
  /** Present but not loaded yet. */
  | 'modelNotReady'
  /** No such API on this OS or browser. */
  | 'platformUnsupported'
  /** The document's language is not supported by the platform. */
  | 'languageNotSupported'
  /** No on-device route and no custom provider configured. */
  | 'noProvider';

export function unavailable(
  reason: PdfAiUnavailableReason,
): { readonly kind: 'unavailable'; readonly reason: PdfAiUnavailableReason } {
  return { kind: 'unavailable', reason };
}

export function isUsable(a: PdfAiAvailability): boolean {
  return a.kind === 'available';
}
