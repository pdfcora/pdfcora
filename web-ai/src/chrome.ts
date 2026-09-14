import { type PdfAiAvailability, unavailable } from './availability.js';
import type { PdfSummaryStyle } from './summaries.js';

/**
 * Chrome's built-in Summarizer API, the one on-device model a web page can use today.
 * Desktop Chrome only: the global is absent in Safari, Firefox and mobile Chrome.
 */
interface ChromeSummarizer {
  readonly inputQuota: number;
  summarize(text: string): Promise<string>;
  destroy(): void;
}

type ChromeAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface ChromeSummarizerOptions {
  type?: 'tldr' | 'key-points';
  format?: 'plain-text';
  length?: 'short' | 'medium' | 'long';
  expectedInputLanguages?: string[];
  monitor?: (monitor: EventTarget) => void;
}

interface ChromeSummarizerClass {
  availability(options?: ChromeSummarizerOptions): Promise<ChromeAvailability>;
  create(options?: ChromeSummarizerOptions): Promise<ChromeSummarizer>;
}

/** Characters per token for Chrome's input quota; low on purpose so a part never overruns it. */
const CHARS_PER_TOKEN = 3;

function api(): ChromeSummarizerClass | undefined {
  return (globalThis as { Summarizer?: ChromeSummarizerClass }).Summarizer;
}

function options(style: PdfSummaryStyle, language?: string): ChromeSummarizerOptions {
  return {
    type: style === 'keyPoints' ? 'key-points' : 'tldr',
    format: 'plain-text',
    length: 'medium',
    ...(language ? { expectedInputLanguages: [language] } : {}),
  };
}

export async function chromeSummarizerAvailability(language?: string): Promise<PdfAiAvailability> {
  const summarizer = api();
  if (!summarizer) return unavailable('platformUnsupported');
  let state: ChromeAvailability;
  try {
    state = await summarizer.availability(options('paragraph', language));
  } catch {
    return unavailable('platformUnsupported');
  }
  if (state === 'unavailable' && language && (await summarizer.availability(options('paragraph'))) !== 'unavailable') {
    return unavailable('languageNotSupported');
  }
  switch (state) {
    case 'available': return { kind: 'available' };
    case 'downloadable': return { kind: 'downloadable' };
    case 'downloading': return { kind: 'downloading' };
    default: return unavailable('deviceNotEligible');
  }
}

/** Starts the model download. Only ever called from the host's `prepare()` (AVL-4). */
export async function prepareChromeSummarizer(onProgress?: (fraction: number) => void): Promise<void> {
  const summarizer = api();
  if (!summarizer) return;
  const created = await summarizer.create({
    ...options('paragraph'),
    monitor: (monitor) => monitor.addEventListener('downloadprogress', (event) => {
      onProgress?.((event as Event & { loaded: number }).loaded);
    }),
  });
  created.destroy();
  onProgress?.(1);
}

/** A summariser for one style, with its input limit in characters. Null when unusable now. */
export async function openChromeSummarizer(style: PdfSummaryStyle, language?: string): Promise<{
  limitChars: number;
  summarise: (text: string) => Promise<string>;
  close: () => void;
} | null> {
  const summarizer = api();
  if (!summarizer || (await summarizer.availability(options(style, language))) !== 'available') return null;
  const created = await summarizer.create(options(style, language));
  return {
    limitChars: Math.max(1, created.inputQuota * CHARS_PER_TOKEN),
    summarise: (text) => created.summarize(text),
    close: () => created.destroy(),
  };
}
