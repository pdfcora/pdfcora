import { PdfLicense } from '@pdfcora/web';

export const TRIAL_PREFIX = 'PDFCora trial — ';
let warned = false;

/** Marks model output produced without an `ai` license. Quotes are never touched. */
export function trialText(text: string, licensed = PdfLicense.covers('ai')): string {
  if (licensed) return text;
  if (!warned) {
    warned = true;
    console.warn('PDFCora: AI output is marked as trial — the license key does not include the ai module');
  }
  return TRIAL_PREFIX + text;
}
