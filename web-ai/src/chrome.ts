import { type PdfAiAvailability, unavailable } from './availability.js';
import type { PdfSummaryStyle } from './summaries.js';

/**
 * Chrome's built-in Summarizer API, the one on-device model a web page can use today.
 * Desktop Chrome only: the global is absent in Safari, Firefox and mobile Chrome.
 */
interface ChromeSummarizer {
  readonly inputQuota: number;
  summarize(text: string): Promise<string>;
  measureInputUsage?(text: string): Promise<number>;
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

/**
 * Characters per token when the API cannot measure, and the tokens Chrome adds to every input.
 * Measured in Chrome 152 on conformance/redaction/pii.pdf: 1.71 characters per token (numbers,
 * emails and IBANs are dense) and about 440 tokens of fixed overhead. The earlier guess of 3 made a
 * dense 30-page document overrun the 9216-token quota on the first call.
 */
const FALLBACK_CHARS_PER_TOKEN = 1.5;
const FALLBACK_OVERHEAD_TOKENS = 600;
/** Room left for text denser than the sample the limit was measured on. */
const MARGIN = 0.8;

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

/**
 * A summariser for one style, with its input limit in characters. Null when unusable now.
 *
 * The limit comes from measuring `sample` (the document's own text) with the API's token counter:
 * characters per token from the difference between the sample and the sample twice, the fixed
 * overhead from what remains. Each call is also measured, and an input over the quota is summarised
 * in halves rather than failing.
 */
export async function openChromeSummarizer(style: PdfSummaryStyle, language?: string, sample = ''): Promise<{
  limitChars: number;
  summarise: (text: string) => Promise<string>;
  close: () => void;
} | null> {
  const summarizer = api();
  if (!summarizer || (await summarizer.availability(options(style, language))) !== 'available') return null;
  const created = await summarizer.create(options(style, language));
  const quota = created.inputQuota;
  const measure = created.measureInputUsage?.bind(created);

  let charsPerToken = FALLBACK_CHARS_PER_TOKEN;
  let overhead = FALLBACK_OVERHEAD_TOKENS;
  const probe = sample.slice(0, 4000);
  if (measure && probe.trim()) {
    const once = await measure(probe);
    const twice = await measure(probe + probe);
    if (twice > once) {
      charsPerToken = probe.length / (twice - once);
      overhead = Math.max(0, once - (twice - once));
    }
  }

  const fit = async (text: string): Promise<string> => {
    if (!measure || (await measure(text)) <= quota || text.length < 2) return created.summarize(text);
    const middle = text.lastIndexOf(' ', Math.floor(text.length / 2)) > 0 ? text.lastIndexOf(' ', Math.floor(text.length / 2)) : Math.floor(text.length / 2);
    return `${await fit(text.slice(0, middle))}\n${await fit(text.slice(middle))}`;
  };

  return {
    limitChars: Math.max(1, Math.floor((quota - overhead) * charsPerToken * MARGIN)),
    summarise: fit,
    close: () => created.destroy(),
  };
}
