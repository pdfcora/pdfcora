import type { PdfDocument } from '@pdfiumkit/web';

import { type PdfAiAvailability, unavailable } from './availability.js';
import { type PdfAiProvider, type PdfAiResult, resolve } from './provider.js';

export * from './availability.js';
export * from './provider.js';
export * from './proposal.js';

export interface PdfiumAIOptions {
  readonly provider?: PdfAiProvider;
  /** Android and Web alpha prompt APIs stay off unless asked for (PRV-5). */
  readonly experimentalOnDevicePrompt?: boolean;
}

/**
 * The entry point. One instance per document.
 *
 * Every feature reports availability separately (AVL-2) and re-checks it on each call
 * (AVL-3), because the user can turn the platform's AI off mid-session.
 */
export class PdfiumAI {
  constructor(
    private readonly document: PdfDocument,
    private readonly options: PdfiumAIOptions = {},
  ) {}

  /**
   * A feature that does nothing, so the not-available path can be exercised before any
   * real feature exists. Delete it when Phase 1 lands.
   */
  readonly stub = {
    availability: async (): Promise<PdfAiAvailability> =>
      // The web has no general on-device model, so this is the honest answer.
      this.options.provider ? { kind: 'available' } : unavailable('platformUnsupported'),

    /**
     * Asks the platform to fetch the model. AVL-4 forbids the SDK starting a download on
     * its own, so this exists to be called by the host and nowhere else.
     *
     * `onProgress` is how AVL-4's "the SDK reports download progress" is met. The web has
     * nothing to download, so it completes immediately.
     */
    prepare: async (onProgress?: (fraction: number) => void): Promise<PdfAiAvailability> => {
      onProgress?.(1);
      return this.stub.availability();
    },

    run: async (): Promise<PdfAiResult<string> | PdfAiAvailability> =>
      resolve<string>({
        customProvider: async () => {
          const provider = this.options.provider;
          if (!provider) return null;
          return (await provider.generate({ prompt: 'ping' })).text;
        },
      }),
  };

  /** The document this instance answers about. */
  get target(): PdfDocument {
    return this.document;
  }
}
