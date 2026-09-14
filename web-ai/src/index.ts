import type { PdfDocument } from '@pdfiumkit/web';

import {
  type PdfAnswer, groundedPrompt, groundedReplySchema, parseReply, passagesForBudget, verifyReply,
} from './answers.js';
import { type PdfAiAvailability, unavailable } from './availability.js';
import { chromeSummarizerAvailability, openChromeSummarizer, prepareChromeSummarizer } from './chrome.js';
import { type PdfAiProvider, type PdfAiResult, resolve } from './provider.js';
import { type PdfSummary, type PdfSummaryStyle, summariseWithin, summaryPrompt } from './summaries.js';
import { type PdfPageRange, type PdfTextIndex, indexDocument, readPages } from './text.js';

export * from './availability.js';
export * from './provider.js';
export * from './proposal.js';
export type { PdfAnswer, PdfCitation } from './answers.js';
export type { PdfSummary, PdfSummaryStyle } from './summaries.js';
export type { PdfPageRange } from './text.js';
export { locateQuote } from './quote.js';

export interface PdfiumAIOptions {
  readonly provider?: PdfAiProvider;
  /**
   * The custom provider's context window, in tokens. The web has no platform to read it
   * from, so it is the integrator's to state. Defaults to 4096.
   */
  readonly providerContextTokens?: number;
  /** Android and Web alpha prompt APIs stay off unless asked for (PRV-5). */
  readonly experimentalOnDevicePrompt?: boolean;
}

export interface PdfSummaryOptions {
  readonly pages?: PdfPageRange;
  readonly style?: PdfSummaryStyle;
  /** BCP 47 code. When given and the platform does not support it, the call is unavailable (SUM-3). */
  readonly language?: string;
}

/**
 * The entry point. One instance per document.
 *
 * Every feature reports availability separately (AVL-2) and re-checks it on each call
 * (AVL-3), because the user can turn the platform's AI off mid-session.
 */
export class PdfiumAI {
  private index?: Promise<PdfTextIndex>;

  constructor(
    private readonly document: PdfDocument,
    private readonly options: PdfiumAIOptions = {},
  ) {}

  /** The document this instance answers about. */
  get target(): PdfDocument {
    return this.document;
  }

  /**
   * Answers questions from the document, citing the sentences they came from (ANS).
   *
   * The web has no on-device prompt API a page can use, so answers need a custom provider.
   */
  readonly answers = {
    availability: async (): Promise<PdfAiAvailability> =>
      this.options.provider ? { kind: 'available' } : unavailable('noProvider'),

    ask: async (question: string): Promise<PdfAiResult<PdfAnswer> | PdfAiAvailability> => {
      const provider = this.options.provider;
      if (!provider) return unavailable('noProvider');

      const index = await this.textIndex();
      const passages = passagesForBudget(index, question, this.options.providerContextTokens ?? 4096);
      // ANS-4: no relevant passage means no model call at all.
      if (passages.length === 0) {
        return { value: { kind: 'notFound', pagesWithoutText: index.pagesWithoutText }, source: 'rules' };
      }

      return resolve<PdfAnswer>({
        customProvider: async () => {
          const response = await provider.generate({
            prompt: groundedPrompt(question, passages),
            schema: groundedReplySchema,
          });
          const reply = parseReply(response.structured, response.text);
          return reply ? verifyReply(this.document, index, passages, reply) : null;
        },
      });
    },
  };

  /** Summarises the document or a page range (SUM). */
  readonly summaries = {
    availability: async (language?: string): Promise<PdfAiAvailability> => {
      const onDevice = await chromeSummarizerAvailability(language);
      if (onDevice.kind === 'unavailable' && onDevice.reason === 'languageNotSupported') return onDevice;
      if (onDevice.kind === 'available' || this.options.provider) return { kind: 'available' };
      // No summariser in this browser at all: what would fix it is a provider.
      return onDevice.kind === 'unavailable' && onDevice.reason === 'platformUnsupported'
        ? unavailable('noProvider') : onDevice;
    },

    /**
     * Downloads the on-device summariser. AVL-4 forbids the SDK starting a download on its
     * own, so this exists to be called by the host and nowhere else.
     */
    prepare: async (onProgress?: (fraction: number) => void): Promise<PdfAiAvailability> => {
      await prepareChromeSummarizer(onProgress);
      return this.summaries.availability();
    },

    summarize: async (options: PdfSummaryOptions = {}): Promise<PdfAiResult<PdfSummary> | PdfAiAvailability> => {
      const style = options.style ?? 'paragraph';
      const onDevice = await chromeSummarizerAvailability(options.language);
      if (onDevice.kind === 'unavailable' && onDevice.reason === 'languageNotSupported') return onDevice;

      const { pages, pagesWithoutText } = await readPages(this.document, options.pages);
      const texts = pages.map((p) => p.text);
      const provider = this.options.provider;

      return resolve<PdfSummary>({
        onDevice: async () => {
          const summarizer = await openChromeSummarizer(style, options.language);
          if (!summarizer) return null;
          try {
            return { text: await summariseWithin(texts, summarizer.limitChars, summarizer.summarise), pagesWithoutText };
          } finally {
            summarizer.close();
          }
        },
        customProvider: provider
          ? async () => {
              const limitChars = Math.floor((this.options.providerContextTokens ?? 4096) * 3 * 0.6);
              const text = await summariseWithin(texts, limitChars, async (part) =>
                (await provider.generate({ prompt: summaryPrompt(part, style) })).text.trim());
              return { text, pagesWithoutText };
            }
          : undefined,
      });
    },
  };

  private textIndex(): Promise<PdfTextIndex> {
    this.index ??= indexDocument(this.document);
    return this.index;
  }
}
