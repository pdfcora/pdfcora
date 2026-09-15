import type { PdfDocument } from '@pdfiumkit/web';

import {
  type PdfAnswer, groundedPrompt, groundedReplySchema, parseReply, passagesForBudget, verifyReply,
} from './answers.js';
import { type PdfAiAvailability, unavailable } from './availability.js';
import { chromeSummarizerAvailability, openChromeSummarizer, prepareChromeSummarizer } from './chrome.js';
import { type PdfAiProvider, type PdfAiResult, resolve } from './provider.js';
import { type PdfSummary, type PdfSummaryStyle, summariseInWindows, summaryPrompt } from './summaries.js';
import { type PdfPageRange, type PdfTextIndex, indexDocument, readPages } from './text.js';
import { trialText } from './trial.js';

export * from './availability.js';
export * from './provider.js';
export * from './proposal.js';
export type { PdfAnswer, PdfCitation } from './answers.js';
export type { PdfSummary, PdfSummaryStyle } from './summaries.js';
export type { PdfPageRange } from './text.js';
export { locateQuote } from './quote.js';
export type {
  PdfRedactionApplied, PdfRedactionCategory, PdfRedactionOptions, PdfRedactionReview, PdfRedactionSuggestion,
} from './redaction/suggest.js';
export type { PdfFormApplied, PdfFormProposal, PdfFormProposals, PdfProfile } from './forms/propose.js';
export type { PdfProfileKey } from './forms/synonyms.js';
import { suggestRedactions, type PdfRedactionOptions, type PdfRedactionReview } from './redaction/suggest.js';
import { proposeFormValues, type PdfFormProposals, type PdfProfile } from './forms/propose.js';
import { detectFields, type PdfDetectedFields } from './forms/detect.js';
export type { PdfDetectedField, PdfDetectedFields } from './forms/detect.js';
import { suggestAltText, type PdfAltTextReview } from './alt-text/suggest.js';
import { proposeRemediation, type PdfRemediationReview } from './remediation/propose.js';
import { compareDocuments, type PdfDiff, type PdfDiffOptions } from './diff/compare.js';
export type { PdfDiff, PdfDiffChange, PdfDiffOptions, PdfDiffSide } from './diff/compare.js';
export type { PdfRemediationBlock, PdfRemediationOptions, PdfRemediationReview } from './remediation/propose.js';
export type { PdfAltTextDecision, PdfAltTextProposal, PdfAltTextReview } from './alt-text/suggest.js';
import type { PdfPageRange as FormPageRange } from './text.js';

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

  /**
   * Proposes values for the document's form fields from a profile the host passes in (FORM).
   * The synonym list runs on every device; the custom provider matches fields it cannot.
   * The profile is not stored. Nothing is written until `apply`.
   */
  readonly forms = {
    propose: (profile: PdfProfile, options?: { pages?: FormPageRange }): Promise<PdfFormProposals> =>
      proposeFormValues(this.document, this.options.provider, profile, options),
    /** Proposes form fields for the blanks of a flat PDF — lines, boxes, underscores (FORM-7). */
    detect: (options?: { pages?: FormPageRange }): Promise<PdfDetectedFields> =>
      detectFields(this.document, options?.pages),
  };

  /**
   * Suggests likely personal data to redact (RED). Patterns run on every device; the custom
   * provider, when configured, adds names, addresses, dates of birth and ID numbers. Nothing
   * is written until `apply`.
   */
  readonly redactions = {
    suggest: (options?: PdfRedactionOptions): Promise<PdfRedactionReview> =>
      suggestRedactions(this.document, this.options.provider, this.options.providerContextTokens ?? 4096, options),
  };

  /**
   * Lists figures in a tagged document that have no alternate text and proposes a description,
   * or decorative marking, for each (ALT). Descriptions need the custom provider. Nothing is
   * written until `apply`, which returns a new document.
   */
  readonly altText = {
    suggest: (options?: { pages?: FormPageRange }): Promise<PdfAltTextReview> =>
      suggestAltText(this.document, this.options.provider, options),
  };

  /**
   * Proposes tags and a reading order for an untagged document (REM), by rules on the page
   * objects, identically on every platform. Nothing is written until `apply`, which returns a
   * new document; describe its figures with `altText` afterwards.
   */
  readonly remediation = {
    suggest: (options?: { pages?: FormPageRange }): Promise<PdfRemediationReview> =>
      proposeRemediation(this.document, options),
  };

  /**
   * Compares this document (the original) with a revised version: sentences aligned without a
   * model, and each reworded pair labelled as a change in meaning or wording by the custom provider.
   */
  readonly diff = {
    compare: (revised: PdfDocument, options?: PdfDiffOptions): Promise<PdfDiff> =>
      compareDocuments(this.document, revised, this.options.provider, options),
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
            return { text: trialText(await summariseInWindows(texts, summarizer.limitChars, summarizer.summarise)), pagesWithoutText };
          } finally {
            summarizer.close();
          }
        },
        customProvider: provider
          ? async () => {
              const limitChars = Math.floor((this.options.providerContextTokens ?? 4096) * 3 * 0.6);
              const text = await summariseInWindows(texts, limitChars, async (part) =>
                (await provider.generate({ prompt: summaryPrompt(part, style) })).text.trim());
              return { text: trialText(text), pagesWithoutText };
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
