import { type PdfAiAvailability, unavailable } from './availability.js';

/** Where an answer came from. Shown to users and logged for audits (PRV-3). */
export type PdfAiSource = 'onDevice' | 'customProvider' | 'rules';

export interface PdfAiResult<T> {
  readonly value: T;
  readonly source: PdfAiSource;
}

export interface PdfAiRequest {
  readonly prompt: string;
  /** Encoded images, for providers that accept them. Apple's model does not. */
  readonly images?: readonly Uint8Array[];
  /** JSON Schema for structured output, when the feature needs one. */
  readonly schema?: unknown;
}

export interface PdfAiResponse {
  readonly text: string;
  readonly structured?: unknown;
}

/** Implemented by the integrator: their own server, or their own model. */
export interface PdfAiProvider {
  generate(request: PdfAiRequest): Promise<PdfAiResponse>;
}

type Route<T> = () => Promise<T | null>;

/**
 * Tries each route in the fixed order of PRV-2 and reports which one answered.
 *
 * A route returns null when it has no answer and throws when it broke; both move on to
 * the next route, because a provider outage must not take down a feature that has a
 * rules fallback.
 */
export async function resolve<T>(routes: {
  onDevice?: Route<T>;
  customProvider?: Route<T>;
  rules?: Route<T>;
}): Promise<PdfAiResult<T> | PdfAiAvailability> {
  const ordered: readonly (readonly [PdfAiSource, Route<T> | undefined])[] = [
    ['onDevice', routes.onDevice],
    ['customProvider', routes.customProvider],
    ['rules', routes.rules],
  ];

  let failed = false;
  for (const [source, route] of ordered) {
    if (!route) continue;
    try {
      const value = await route();
      if (value != null) return { value, source };
    } catch {
      // Swallowed so the next route can answer, but remembered: a failure is not a
      // missing configuration, and reporting it as one sends the integrator the wrong way.
      failed = true;
    }
  }
  return unavailable(failed ? 'requestFailed' : 'noProvider');
}
