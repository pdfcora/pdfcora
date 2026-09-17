import type { PdfDocument, PdfRect, PdfStructureElement } from '@pdfcora/web';
import { encodePng } from './png.js';
import type { PdfPageRange } from '../text.js';
import { resolve, type PdfAiProvider, type PdfAiSource } from '../provider.js';
import { trialText } from '../trial.js';

export const ALT_TEXT_NOTICE = 'Check every description before it is written.';

export interface PdfAltTextProposal {
  /** `"<pageIndex>:<marked-content ids joined by ,>"`. */
  readonly id: string;
  readonly pageIndex: number;
  readonly markedContentIds: readonly number[];
  readonly rect: PdfRect;
  readonly kind: 'description' | 'decorative';
  /** Empty when no route proposed a description; a person writes one. */
  readonly text: string;
  readonly source: PdfAiSource | null;
  /** The page text given to the model as context. */
  readonly context: string;
}

/** A person's decision on one proposal: `text` replaces the proposed description. */
export interface PdfAltTextDecision {
  readonly id: string;
  readonly text?: string;
  readonly decorative?: boolean;
}

export interface PdfAltTextReview {
  /** True when the document is not tagged: nothing is listed, it needs tags first. */
  readonly untagged: boolean;
  readonly items: readonly PdfAltTextProposal[];
  readonly modelUsed: boolean;
  /** Must be shown with the proposals (HIL). */
  readonly notice: string;
  /** Writes the decisions, returning a new document; this document is unchanged. */
  apply(decisions: readonly PdfAltTextDecision[]): Promise<PdfDocument>;
}

const CONTEXT_MARGIN = 48;
const CONTEXT_CHARS = 500;
const IMAGE_PIXELS = 512;
const MAX_SCALE = 4;

export const altTextSchema = {
  type: 'object',
  properties: { decorative: { type: 'boolean' }, description: { type: 'string' } },
  required: ['decorative', 'description'],
};

export function altTextPrompt(context: string): string {
  return [
    'Write alternative text for the attached image from a PDF, for a reader who cannot see it.',
    'One sentence of at most 150 characters saying what the image shows and why it matters here.',
    'Do not begin with "Image of" or "Picture of".',
    'If the image is only decoration and adds no information, answer decorative true with an empty description.',
    `Text near the image on the page: ${JSON.stringify(context)}`,
  ].join('\n');
}

/** Spec §2: too thin or too small to carry information. */
export function looksDecorative(rect: PdfRect): boolean {
  const width = rect.right - rect.left;
  const height = rect.top - rect.bottom;
  return Math.min(width, height) <= 3 || width * height <= 100;
}

const hasText = (value?: string) => (value ?? '').trim().length > 0;

function missingAlt(elements: readonly PdfStructureElement[]): PdfStructureElement[] {
  return elements.flatMap((e) => [
    ...(e.type === 'Figure' && !hasText(e.altText) && !hasText(e.actualText) && e.bounds && e.markedContentIds.length > 0 ? [e] : []),
    ...missingAlt(e.children),
  ]);
}

export async function suggestAltText(
  document: PdfDocument,
  provider: PdfAiProvider | undefined,
  options: { pages?: PdfPageRange } = {},
): Promise<PdfAltTextReview> {
  const untagged = !(await document.isTagged());
  const items: PdfAltTextProposal[] = [];
  let modelUsed = false;

  const count = await document.pageCount();
  const from = Math.max(0, options.pages?.from ?? 0);
  const to = Math.min(count - 1, options.pages?.to ?? count - 1);
  for (let pageIndex = from; !untagged && pageIndex <= to; pageIndex++) {
    const page = await document.page(pageIndex);
    const figures = missingAlt(await page.structure())
      .sort((a, b) => b.bounds!.top - a.bounds!.top || a.bounds!.left - b.bounds!.left);
    if (figures.length === 0) continue;
    const characters = await pageCharacters(document, pageIndex);

    for (const figure of figures) {
      const rect = figure.bounds!;
      const base = {
        id: `${pageIndex}:${figure.markedContentIds.join(',')}`,
        pageIndex, markedContentIds: figure.markedContentIds, rect,
        context: contextFor(rect, characters),
      };
      if (looksDecorative(rect)) {
        items.push({ ...base, kind: 'decorative', text: '', source: 'rules' });
        continue;
      }
      const answer = provider
        ? await resolve<{ decorative: boolean; description: string }>({
            customProvider: async () => {
              const response = await provider.generate({
                prompt: altTextPrompt(base.context),
                images: [await figureImage(document, pageIndex, rect)],
                schema: altTextSchema,
              });
              return parseAnswer(response.structured, response.text);
            },
          })
        : undefined;
      if (answer && 'value' in answer) {
        modelUsed = true;
        items.push({
          ...base,
          kind: answer.value.decorative ? 'decorative' : 'description',
          text: answer.value.decorative ? '' : trialText(answer.value.description),
          source: answer.source,
        });
      } else {
        items.push({ ...base, kind: 'description', text: '', source: null });
      }
    }
  }

  return {
    untagged, items, modelUsed, notice: trialText(ALT_TEXT_NOTICE),
    apply: async (decisions) => {
      const byId = new Map(items.map((item) => [item.id, item]));
      const edits = decisions.map((decision) => {
        const item = byId.get(decision.id);
        if (!item) throw new Error(`unknown alt text proposal: ${decision.id}`);
        const decorative = decision.decorative ?? item.kind === 'decorative';
        const text = (decision.text ?? item.text).trim();
        if (!decorative && !text) throw new Error(`no description for ${decision.id}`);
        return decorative
          ? { pageIndex: item.pageIndex, markedContentIds: item.markedContentIds, decorative: true as const }
          : { pageIndex: item.pageIndex, markedContentIds: item.markedContentIds, altText: text };
      });
      return document.updateFigures(edits);
    },
  };
}

function parseAnswer(structured: unknown, text: string): { decorative: boolean; description: string } | null {
  let value = structured;
  if (value === undefined) {
    try { value = JSON.parse(text); } catch { return null; }
  }
  if (typeof value !== 'object' || value === null) return null;
  const { decorative, description } = value as { decorative?: unknown; description?: unknown };
  if (decorative === true) return { decorative: true, description: '' };
  return typeof description === 'string' && description.trim() ? { decorative: false, description: description.trim() } : null;
}

interface Character { readonly char: string; readonly box: PdfRect | null }

async function pageCharacters(document: PdfDocument, pageIndex: number): Promise<Character[]> {
  const page = await document.page(pageIndex);
  const text = await page.text.string();
  const characters: Character[] = [];
  for (let i = 0; i < text.length; i++) {
    const box = await page.text.boundingBox(i);
    characters.push({ char: text[i]!, box: box.right > box.left && box.top > box.bottom ? box : null });
  }
  return characters;
}

/** Spec §5.2: characters whose centre lies within 48 pt above or below the figure, across the page. */
export function contextFor(rect: PdfRect, characters: readonly Character[]): string {
  const inside = (b: PdfRect) => {
    const y = (b.bottom + b.top) / 2;
    return y >= rect.bottom - CONTEXT_MARGIN && y <= rect.top + CONTEXT_MARGIN;
  };
  const text = characters.map(({ char, box }) => (box && inside(box) ? char : ' ')).join('');
  return text.replace(/\s+/g, ' ').trim().slice(0, CONTEXT_CHARS);
}

async function figureImage(document: PdfDocument, pageIndex: number, rect: PdfRect): Promise<Uint8Array> {
  const page = await document.page(pageIndex);
  const size = await page.size();
  const scale = Math.min(MAX_SCALE, IMAGE_PIXELS / Math.max(rect.right - rect.left, rect.top - rect.bottom));
  const image = await page.render({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) });

  const x0 = Math.max(0, Math.floor(rect.left * scale));
  const y0 = Math.max(0, Math.floor((size.height - rect.top) * scale));
  const x1 = Math.min(image.width, Math.ceil(rect.right * scale));
  const y1 = Math.min(image.height, Math.ceil((size.height - rect.bottom) * scale));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((y0 + y) * image.width + x0) * 4;
    pixels.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return encodePng(width, height, pixels);
}
