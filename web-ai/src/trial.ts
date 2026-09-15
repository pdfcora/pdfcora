import { PdfLicense } from '@pdfiumkit/web';

export const TRIAL_PREFIX = 'PdfiumKit trial — ';
let warned = false;

/** Marks model output produced without an `ai` license. Quotes are never touched. */
export function trialText(text: string, licensed = PdfLicense.covers('ai')): string {
  if (licensed) return text;
  if (!warned) {
    warned = true;
    console.warn('PdfiumKit: AI output is marked as trial — the license key does not include the ai module');
  }
  return TRIAL_PREFIX + text;
}
